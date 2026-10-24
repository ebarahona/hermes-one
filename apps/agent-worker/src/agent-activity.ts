// agent-worker (agent plane): the bounded, policy-gated agent turn as a Temporal activity
// (ADR-017/021). Boots the agentback app + model + substrate store ONCE per worker process; per turn it
// resolves the tenant's ACTIVE DEPLOYMENT and loads, from it, the AgentEngineContract (→ allowedCapabilities),
// the CapabilityContracts (→ scope-gated tool set + envelope metadata), and the CompiledPolicyPlan
// (→ live pre/post gates). Nothing is hardcoded — the runtime is deployment-driven (ADR-014/016/019).
// The turn crosses the workflow→agent boundary as a serializable TurnRequest→TurnResult; the workflow
// never imports @agentback/*.
//
// The turn resolves the deployment PINNED in workspace.tenantRuntime.deployment (D1): the edge
// resolves-active-and-pins at workflow start, so a publish mid-conversation never changes an in-flight
// conversation's engine/policy/capabilities, and Temporal replay resolves the same (immutable,
// possibly superseded) deployment the original execution used. Fail-closed: an unknown pin throws
// (typed not_found, non-retryable) — never a silent fallback to the active deployment.
import {Context} from '@agentback/context';
import {Context as ActivityContext} from '@temporalio/activity';
import {
  MCPBindings,
  MCP_DISPATCH_HOOK_TAG,
  type MCPServer,
} from '@agentback/mcp';
import {
  type AgentEngineContract,
  type CapabilityContract,
  type CapabilityName,
  type CompiledPolicyPlan,
  type PlanId,
  type Scope,
  type TenantId,
  type ToolCall,
  type TraceHeader,
  type TurnContext,
  type TurnRequest,
  type TurnResult,
} from '@hermes-one/contracts';
import {
  capabilitiesForEngine,
  deriveIdempotencyKey,
  ProviderRegistry,
  ProviderResolver,
} from '@hermes-one/capability-contract';
import {ExpressionPolicyRuntime} from '@hermes-one/policy-dsl';
import {builtinRegistry} from '@hermes-one/expression-core';
import {loadConfig} from '@hermes-one/config';
import {
  createOpenAICompatibleModel,
  type SingleStepModel,
} from '@hermes-one/model-client';
import {
  createAgentPlaneApp,
  CapabilityToolProjector,
} from '@hermes-one/agentback-runtime';
import {InternalSchedulerProvider} from '@hermes-one/scheduler';
import {
  EnvelopeCredentialStore,
  FallbackCredentialStore,
  LocalAesGcmCipher,
  StaticProviderCredentialStore,
} from '@hermes-one/secrets';
import {
  PlatformToolExecutor,
  createEnvelopeHook,
  metaSourceFrom,
  type DispatchResult,
  type ToolBindingSource,
  type ProviderIdSource,
} from '@hermes-one/tool-executor';
import {
  createModelDecider,
  runTurn,
  type DeciderTool,
  type TurnLedger,
} from '@hermes-one/agent-runtime';
import {
  assertRlsPostureAtBoot,
  createCompiledPlanStore,
  createCredentialRowStore,
  createProviderMappingRepository,
  createTurnPersistence,
  type CompiledPlanStore,
  type DrizzleTurnPersistence,
  type TurnLedgerRows,
  type HandoffTaskRow,
} from '@hermes-one/drizzle';
import {
  correlationFromWorkspace,
  type IsoTimestamp,
  type Logger,
  type Meter,
  type PrincipalId,
  type ProviderCredentialStore,
} from '@hermes-one/contracts';
import {
  JsonLogger,
  RedactingLogger,
  FieldRedactor,
  LoggingMeter,
  initTracing,
  tracingConfigFor,
  type Tracer,
  type TracingHandle,
} from '@hermes-one/telemetry';
import {parentTraceparentFromArg} from '@hermes-one/temporal-client';
import {deriveAuditEvents} from './audit-events.js';
import {deriveUsageEvents} from './usage-events.js';
import {emitTurnMetrics} from './turn-metrics.js';

// Structured, PII-redacting logger: the composed reply is free-text (may contain customer PII) → masked
// before export. The real redaction rule set comes from the PII data-classification (flagged, OB5).
const turnLogger: Logger = new RedactingLogger(
  new JsonLogger('info'),
  new FieldRedactor([
    {fieldPath: 'reply', dataClass: 'free-text', strategy: 'mask'},
  ]),
);
// Metrics catalog: emitted as structured logs in dev (OTel exporter is the prod swap, flagged OB5).
const meter: Meter = new LoggingMeter(new JsonLogger('info'));

const toolNameOf = (cap: string) => cap.replace(/\./g, '_');

/**
 * The tool executor with an `agent.tool.<capability>` span per dispatch — a child of the turn span,
 * carrying the attributes (tenant.id, turn.id, tool.capability, tool.side_effect, tool.ok). It
 * subclasses `PlatformToolExecutor` (the turn loop dispatches via that concrete type) and wraps its
 * `dispatch`, so both `dispatch` and the inherited `execute` are traced. (
 * the `agent.tool.*` leaves of the span tree.)
 */
class TracingToolExecutor extends PlatformToolExecutor {
  constructor(
    server: MCPServer,
    parent: Context,
    metaSource: ReturnType<typeof metaSourceFrom>,
    private readonly tracer: Tracer,
    private readonly turnTraceparent: string,
    private readonly tenantId: string,
    private readonly turnId: string,
    bindingSource?: ToolBindingSource,
    providerIdSource?: ProviderIdSource,
  ) {
    super(server, parent, metaSource, bindingSource, providerIdSource);
  }

  override async dispatch(
    call: ToolCall,
    ctx: TurnContext,
  ): Promise<DispatchResult> {
    const span = this.tracer.startSpan(`agent.tool.${call.capability}`, {
      parentTraceparent: this.turnTraceparent,
      attributes: {
        'tenant.id': this.tenantId,
        'turn.id': this.turnId,
        'tool.capability': call.capability,
      },
    });
    try {
      const d = await super.dispatch(call, ctx);
      span.setAttributes({
        'tool.side_effect': d.result.sideEffect,
        'tool.ok': d.result.ok,
      });
      span.end({ok: d.result.ok});
      return d;
    } catch (err) {
      span.end({ok: false, error: err as Error});
      throw err;
    }
  }
}

// The `model-call` retry class sets heartbeatTimeout:'20s' (retry-policy registry) — a turn that
// runs long (slow model, several tool steps) must emit liveness or Temporal kills the attempt. No-op
// outside an activity context (unit tests / direct calls).
function startHeartbeat(intervalMs = 5_000): () => void {
  let ctx: ActivityContext;
  try {
    ctx = ActivityContext.current();
  } catch {
    return () => {};
  }
  const timer = setInterval(() => ctx.heartbeat(), intervalMs);
  return () => clearInterval(timer);
}

interface Booted {
  app: ReturnType<typeof createAgentPlaneApp>;
  server: MCPServer;
  model: SingleStepModel;
  store: CompiledPlanStore;
  persistence: DrizzleTurnPersistence;
  tracer: Tracer;
  tracing: TracingHandle;
  projector: CapabilityToolProjector;
  credentials: ProviderCredentialStore;
  mappingOverrides: import('@hermes-one/drizzle').DrizzleProviderMappingRepository;
}
let booted: Promise<Booted> | undefined;

function boot(): Promise<Booted> {
  return (booted ??= (async () => {
    const cfg = loadConfig();
    // RLS boot self-check (RLS): a bypass-capable login fails startup, not silently.
    await assertRlsPostureAtBoot(cfg.stores.authoritative.url);
    const app = createAgentPlaneApp();
    app
      .bind('platform.hook.envelope')
      .to(createEnvelopeHook())
      .tag(MCP_DISPATCH_HOOK_TAG);
    await app.start();
    const server = await app.get<MCPServer>(MCPBindings.SERVER);
    const model = createOpenAICompatibleModel(cfg.llm);
    const {store} = createCompiledPlanStore(
      cfg.stores.authoritative.url,
      cfg.stores.ephemeral.url,
    );
    const {repo: persistence} = createTurnPersistence(
      cfg.stores.authoritative.url,
    );
    // OTel tracing (OB5): one provider per worker process; spans export to the configured exporter.
    const tracing = initTracing(
      tracingConfigFor(cfg.otel, 'hermes-agent-worker'),
    );
    // The PROVIDER PLANE in the agent plane (tool projection). Before this the agent plane had no
    // ProviderRegistry at all and dispatched to the SpikeBookingTools fixtures; now a pinned capability
    // projects to a tool whose generic body resolves the ranked adapter here. Adapters are plane-neutral
    // (@hermes-one/*, no @loopback/*) so the agent plane may import them (ADR-017 / plane-lint).
    const providers = new ProviderRegistry([new InternalSchedulerProvider()]);
    const projector = new CapabilityToolProjector(
      (capability, mapping, facts) =>
        new ProviderResolver(providers).resolve(capability, mapping, facts),
    );
    // ProviderCredentialStore (port in @hermes-one/contracts, impl in the plane-neutral
    // infrastructure/secrets — ledger S7): the agent plane could never import the old edge-plane
    // store, which is WHY providerConfig was {} here (PE7). internal-scheduler is credential-less —
    // an EXPLICIT empty bundle; absence stays fail-closed. The per-tenant envelope store (ADR-026)
    // swaps in behind this same port.
    const platformDefaults = new StaticProviderCredentialStore({
      [new InternalSchedulerProvider().providerId]: {},
    });
    // ADR-026: with a master key configured, per-tenant envelope-encrypted rows take precedence and
    // the static env bundle becomes the platform DEFAULT a tenant falls back to until they bring
    // their own vendor account (rotate()). Without a key: static only, exactly as before.
    const mappingOverrides = createProviderMappingRepository(
      cfg.stores.authoritative.url,
    ).repo;
    const credentials = cfg.credentials
      ? new FallbackCredentialStore(
          new EnvelopeCredentialStore(
            createCredentialRowStore(cfg.stores.authoritative.url).repo,
            new LocalAesGcmCipher(cfg.credentials.masterKey),
          ),
          platformDefaults,
        )
      : platformDefaults;
    return {
      app,
      server,
      model,
      store,
      persistence,
      tracer: tracing.tracer,
      tracing,
      projector,
      credentials,
      mappingOverrides,
    };
  })());
}

/** Flush + shut the tracing provider down on worker stop so batched spans are not lost. */
export async function shutdownAgentWorker(): Promise<void> {
  if (booted) await (await booted).tracing.shutdown();
}

// HandoffConfig routing defaults are not wired yet (no tenant config store) — 'general'/'normal', no
// expiry (flagged, DEFERRED-AND-FLAGGED). The turn grounds reason/summary/evidence; the edge fills these.
function toHandoffRow(
  h: NonNullable<TurnLedger['handoff']>,
  now: Date,
): HandoffTaskRow {
  return {
    handoffId: h.handoffId,
    conversationId: h.conversationId as string,
    triggeringTurnId: h.triggeringTurnId,
    reason: h.reason,
    priority: 'normal',
    summary: h.summary,
    evidenceSnapshot: h.evidenceSnapshot,
    queue: 'general',
    status: 'requested',
    owner: 'agent',
    transitions: [
      {from: null, to: 'requested', by: 'prn_system', at: now.toISOString()},
    ],
    requestedAt: now,
    updatedAt: now,
  };
}

/** Map the agent plane's TurnLedger (contract types) onto the Drizzle row shapes (edge concern). */
function toLedgerRows(l: TurnLedger): TurnLedgerRows {
  return {
    toolExecutions: l.toolExecutions.map(({call, result}) => ({
      toolCallId: result.toolCallId,
      turnId: l.turnId,
      capabilityName: result.capability,
      input: call.input,
      idempotencyKey: call.idempotencyKey,
      ok: result.ok,
      output: result.output,
      sideEffect: result.sideEffect,
      stateChanged: result.stateChanged,
      changedDomains: [...result.changedDomains],
      metrics: result.metrics,
      error: result.error,
      proposedAt: new Date(call.proposedAt),
    })),
    evidence: l.evidence.map(e => ({
      id: e.id,
      turnId: e.turnId,
      toolCallId: e.toolCallId ?? undefined,
      kind: e.kind,
      capabilityName: e.capability ?? undefined,
      statement: e.statement,
      data: e.data,
      source: e.source,
      trusted: e.trusted,
      observedAt: new Date(e.observedAt),
    })),
    policyDecisions: l.policyDecisions.map(p => ({
      decisionId: p.decisionId,
      turnId: l.turnId,
      correlationId: l.correlationId,
      site: p.site,
      policyRuleId: p.decision.policyRuleId,
      outcome: p.decision.outcome,
      reason: p.decision.reason,
      detail: p.decision.detail,
      capabilityName: p.capability,
      decidedAt: new Date(p.decision.decidedAt),
    })),
  };
}

export async function agentTurn(
  request: TurnRequest,
  trace?: TraceHeader,
): Promise<TurnResult> {
  const stopHeartbeat = startHeartbeat();
  try {
    return await runAgentTurn(request, trace);
  } finally {
    stopHeartbeat();
  }
}

async function runAgentTurn(
  request: TurnRequest,
  trace?: TraceHeader,
): Promise<TurnResult> {
  const {
    app,
    server,
    model,
    store,
    persistence,
    tracer,
    projector,
    credentials,
    mappingOverrides,
  } = await boot();
  const tenantId = request.workspace.tenantRuntime.tenantId as TenantId;
  const scopes = request.workspace.principal.scopes as Scope[];
  const principalId = request.workspace.principal.id as PrincipalId;
  const conversationId = request.workspace.conversationId;

  // Resolve the PINNED deployment (D1) and load its engine / capabilities / policy (content-hash-addressed).
  const pin = request.workspace.tenantRuntime.deployment;
  const deployment = await store.resolveDeployment(tenantId, pin.deploymentId);
  const engine = (await store.resolveContractCached(
    tenantId,
    deployment.agentEngine.definitionId,
    deployment.agentEngine.contentHash,
  )) as unknown as AgentEngineContract;
  const capContracts = (await Promise.all(
    deployment.capabilities.map(c =>
      store.resolveContractCached(tenantId, c.definitionId, c.contentHash),
    ),
  )) as unknown as CapabilityContract[];
  const policyPlan = (await store.resolvePlanCached(
    tenantId,
    deployment.policy.planId as PlanId,
    deployment.policy.contentHash,
  )) as unknown as CompiledPolicyPlan;

  const eligibleDefaults = capabilitiesForEngine(
    engine.body.allowedCapabilities,
    capContracts,
    scopes,
  );
  // Tenant provider-mapping overrides (CT3): substituted into the PINNED contracts before projection —
  // the contract stays immutable/content-hashed; the override is plain tenant-row CRUD applied at
  // turn assembly, mirroring the edge invoker. Absence of a row = the contract default.
  const eligible = await Promise.all(
    eligibleDefaults.map(async c => {
      const o = await mappingOverrides.find(tenantId, c.name);
      return o
        ? {
            ...c,
            providerMapping: {
              providers: o.providers,
              eligibility: o.eligibility,
              onNoProvider: o.onNoProvider,
            },
          }
        : c;
    }),
  );
  const byName = new Map(capContracts.map(c => [c.name, c]));
  const metaSource = metaSourceFrom(n => byName.get(n));

  // Project THIS turn's pinned capabilities into agentback tools whose generic body reaches the ranked
  // provider (tool projection). Per-turn rather than once-per-deployment: this worker is a
  // multi-tenant singleton, so app-level registration keyed by tool NAME could not hold two tenants'
  // contracts for the same capability. A contract the projector cannot faithfully rebuild is SKIPPED
  // (never degraded to a weaker validator) and logged — the model then simply never sees that tool.
  // Which adapter served each capability this turn — recorded at dispatch by the projected body, read
  // back when the executor synthesizes ToolMetrics.providerId. Per-turn, so it cannot bleed tenants.
  const servedBy = new Map<string, string>();
  // Provider eligibility (ProviderMapping.eligibility) is an expression over TENANT-RUNTIME facts —
  // residency, features, channel. Passing {} would make every fact-referencing rule read undefined,
  // silently ineligible-or-eligible by accident.
  const facts: Record<string, unknown> = {
    tenantId,
    channel: request.workspace.channel,
    dataResidency: request.workspace.tenantRuntime.tenant.dataResidency,
    features: request.workspace.tenantRuntime.tenant.features,
    locale: request.workspace.tenantRuntime.locale,
  };
  // Project ONLY the scope-eligible subset: an out-of-scope capability must not have a callable
  // binding at all (ADR-019 fail-closed), not merely be withheld from the model's tool list.
  const projected = projector.project(eligible, {
    tenantId,
    facts,
    // Credentials resolve per (tenant, provider, capability) AFTER ranking picks the adapter (PE7
    // closed): the record's decrypted bundle becomes ProviderExecutionContext.config.
    providerConfigFor: async (capability, providerId) =>
      (await credentials.resolve(tenantId, providerId, capability)).config,
    // Canonical material: turnId + name + the contract's keyFields values (deriveIdempotencyKey).
    // keyFields come from the INPUT, so two calls to one
    // capability with different arguments in a turn get distinct keys.
    idempotencyKeyFor: (capability, input) => {
      const contract = byName.get(capability);
      return contract
        ? deriveIdempotencyKey(contract, input, request.turnId)
        : `${request.turnId}:${capability}`;
    },
    onProviderResolved: (capability, providerId) =>
      servedBy.set(capability, providerId),
  });
  for (const s of projected.report.skipped) {
    turnLogger.log({
      level: 'warn',
      message: 'capability projection skipped',
      timestamp: new Date().toISOString(),
      correlation: correlationFromWorkspace(request.workspace, request.turnId),
      fields: {capability: s.capability, reason: s.reason},
    });
  }
  const bindingSource: ToolBindingSource = (capability: CapabilityName) =>
    projected.bindings.get(capability);

  // The model only ever sees capabilities that BOTH pass the scope gate AND projected to a real
  // provider-backed tool. Offering a skipped capability would let dispatch fall through to whatever
  // else answers to that name — the fixture path this slice retires — and pass canned data off as
  // provider evidence. Fail-closed: no binding, no tool.
  const tools: DeciderTool[] = eligible
    .filter(c => projected.bindings.has(c.name))
    .map(c => ({
      toolName: toolNameOf(c.name),
      capability: c.name,
      description: c.description,
      parameters: c.inputJsonSchema,
    }));

  // The turn's tool VISIBILITY — the three-way narrowing (engine.allowedCapabilities ∩ principal
  // scopes ∩ successfully-projected). Logged because "why didn't the agent use the tool?" is
  // otherwise indistinguishable between an unscoped principal, an engine that never allowed it, and
  // a model that simply chose not to call it.
  turnLogger.log({
    level: 'info',
    message: 'agent turn tool set',
    timestamp: new Date().toISOString(),
    correlation: correlationFromWorkspace(request.workspace, request.turnId),
    fields: {
      allowed: engine.body.allowedCapabilities,
      pinned: capContracts.map(c => c.name),
      scoped: eligible.map(c => c.name),
      offered: tools.map(t => t.capability),
    },
  });

  const decider = createModelDecider({
    model,
    // The PINNED engine's model drives this turn; an empty engine model falls back to cfg.llm.model.
    modelId: engine.body.model.model,
    temperature: engine.body.model.temperature,
    objective: `${request.objective} (inbound: ${request.inbound.text ?? ''})`,
    tools,
    // toolCallIds derive from (turnId, step) — replay-stable within a turn, disjoint across turns.
    turnId: request.turnId,
    // Canonical key material: turnId + name + the contract's keyFields (deriveIdempotencyKey).
    // The decider's own placeholder is capability+args with NO
    // turn — and `te_tenant_idempotency_uq` is UNIQUE per (tenant, key), so two DIFFERENT turns calling
    // one capability with equal args collapsed to a single ledger row (the later turn's execution was
    // silently dropped by ON CONFLICT DO NOTHING while its audit trail still logged tool.invoked).
    idempotencyKeyFor: (capability, args) => {
      const contract = byName.get(capability);
      return contract
        ? deriveIdempotencyKey(contract, args, request.turnId)
        : `${request.turnId}:${capability}`;
    },
  });

  // Span tree (OB5): temporal.activity.agentTurn (child of the edge trace via the explicit sidecar) →
  // agent.turn → agent.tool.<capability> (per dispatch, opened by the tracing executor). Every terminal
  // path (success, failed outcome, or a thrown error) ends both spans so nothing leaks.
  const activitySpan = tracer.startSpan('temporal.activity.agentTurn', {
    parentTraceparent: parentTraceparentFromArg(trace),
    attributes: {'tenant.id': tenantId, 'turn.id': request.turnId},
  });
  const turnSpan = tracer.startSpan('agent.turn', {
    parentTraceparent: activitySpan.traceparent,
    attributes: {'tenant.id': tenantId, 'turn.id': request.turnId},
  });
  const tracingExecutor = new TracingToolExecutor(
    server,
    app as unknown as Context,
    metaSource,
    tracer,
    turnSpan.traceparent,
    tenantId,
    request.turnId,
    bindingSource,
    // CONSUME-ONCE: a dispatch that never resolved a provider (NoProviderError) must not read back
    // the PREVIOUS call's providerId and stamp it onto an ok:false envelope for a provider that was
    // never reached.
    (capability: CapabilityName) => {
      const id = servedBy.get(capability);
      servedBy.delete(capability);
      return id;
    },
  );

  let capturedLedger: TurnLedger | undefined;
  const startedMs = Date.now();
  let result: TurnResult;
  try {
    result = await runTurn(request, {
      executor: tracingExecutor,
      decider,
      policy: {
        plan: policyPlan,
        runtime: new ExpressionPolicyRuntime(builtinRegistry()),
      },
      // Durable turn persistence (Tier 2, made ATOMIC in F3): ONE tenant-scoped transaction commits the
      // ledger, the initial handoff_tasks request, the append-only audit trail, the usage records, and an
      // event_outbox row per audit event (commit-and-publish) — a crash mid-persist leaves nothing, never
      // a ledger without its audit trail or billing record. Idempotent; a Temporal retry collapses.
      onPersist: async turnLedger => {
        capturedLedger = turnLedger;
        // REPLAY-STABLE time (Phase 2a): the workflow stamped request.startedAt from ITS clock, so a
        // re-execution with identical args re-derives identical audit rows (id AND integrityHash) —
        // the precondition for the audit sink's tamper-reject (AU2). Wall clock here would make every
        // re-execution look like tampering.
        const now = new Date(request.startedAt);
        const occurredAt = request.startedAt as IsoTimestamp;
        await persistence.persistTurnAtomic(
          {
            ledger: toLedgerRows(turnLedger),
            handoff:
              turnLedger.handoff && turnLedger.handoff.conversationId
                ? toHandoffRow(turnLedger.handoff, now)
                : undefined,
            auditEvents: deriveAuditEvents(turnLedger, {
              principalId,
              conversationId,
              occurredAt,
            }),
            // Usage metering (exactly-once on dedupeKey) — model tokens/cost + tool-invocation count.
            usageEvents: deriveUsageEvents(turnLedger, {
              principalId,
              occurredAt,
            }),
          },
          {tenantId},
        );
      },
    });
  } catch (err) {
    turnSpan.end({ok: false, error: err as Error});
    activitySpan.end({ok: false, error: err as Error});
    throw err;
  }

  // Metrics catalog (Tier 3.7): turn count/latency, per-tool invocation count/latency, per-gate decision
  // count — the SLO signals. Derived from the captured ledger + wall latency.
  if (capturedLedger)
    emitTurnMetrics(
      meter,
      capturedLedger,
      result.outcome,
      Date.now() - startedMs,
    );

  // Structured, correlation-tagged, PII-redacting completion log (the reply is masked before export).
  turnLogger.log({
    level: 'info',
    message: 'agent turn complete',
    timestamp: new Date().toISOString(),
    correlation: correlationFromWorkspace(request.workspace, request.turnId),
    fields: {
      outcome: result.outcome,
      reply: result.reply,
      toolCount: result.metrics.toolCount,
      steps: result.steps,
    },
  });

  const ok = result.outcome !== 'failed';
  turnSpan.setAttributes({'turn.outcome': result.outcome});
  turnSpan.end({ok});
  activitySpan.end({ok});
  return result;
}
