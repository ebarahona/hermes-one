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
import {MCPBindings, MCP_DISPATCH_HOOK_TAG, type MCPServer} from '@agentback/mcp';
import {
  type AgentEngineContract,
  type CapabilityContract,
  type CompiledPolicyPlan,
  type PlanId,
  type Scope,
  type TenantId,
  type TurnRequest,
  type TurnResult,
} from '@platform/contracts';
import {capabilitiesForEngine} from '@platform/capability-contract';
import {ExpressionPolicyRuntime} from '@platform/policy-dsl';
import {builtinRegistry} from '@platform/expression-core';
import {loadConfig} from '@platform-internal/config';
import {createOpenAICompatibleModel, type SingleStepModel} from '@platform-internal/model-client';
import {createAgentPlaneApp} from '@platform-internal/agentback-runtime';
import {
  PlatformToolExecutor,
  createEnvelopeHook,
  metaSourceFrom,
} from '@platform-internal/tool-executor';
import {createModelDecider, runTurn, type DeciderTool, type TurnLedger} from '@platform-internal/agent-runtime';
import {
  assertRlsPostureAtBoot,
  createCompiledPlanStore,
  createTurnPersistence,
  type CompiledPlanStore,
  type DrizzleTurnPersistence,
  type TurnLedgerRows,
  type HandoffTaskRow,
} from '@platform-internal/drizzle';
import {correlationFromWorkspace, type IsoTimestamp, type Logger, type Meter, type PrincipalId} from '@platform/contracts';
import {JsonLogger, RedactingLogger, FieldRedactor, LoggingMeter} from '@platform-internal/telemetry';
import {deriveAuditEvents} from './audit-events.js';
import {deriveUsageEvents} from './usage-events.js';
import {emitTurnMetrics} from './turn-metrics.js';

// Structured, PII-redacting logger: the composed reply is free-text (may contain customer PII) → masked
// before export. The real redaction rule set comes from the PII data-classification (flagged, OB5).
const turnLogger: Logger = new RedactingLogger(
  new JsonLogger('info'),
  new FieldRedactor([{fieldPath: 'reply', dataClass: 'free-text', strategy: 'mask'}]),
);
// Metrics catalogue: emitted as structured logs in dev (OTel exporter is the prod swap, flagged OB5).
const meter: Meter = new LoggingMeter(new JsonLogger('info'));

const toolNameOf = (cap: string) => cap.replace(/\./g, '_');

// The `model-call` retry class sets heartbeatTimeout:'20s' (retry-policy-registry.md) — a turn that
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
}
let booted: Promise<Booted> | undefined;

function boot(): Promise<Booted> {
  return (booted ??= (async () => {
    const cfg = loadConfig();
    // RLS boot self-check (row-level-security.md): a bypass-capable login fails startup, not silently.
    await assertRlsPostureAtBoot(cfg.stores.authoritative.url);
    const app = createAgentPlaneApp();
    app.bind('platform.hook.envelope').to(createEnvelopeHook()).tag(MCP_DISPATCH_HOOK_TAG);
    await app.start();
    const server = await app.get<MCPServer>(MCPBindings.SERVER);
    const model = createOpenAICompatibleModel(cfg.llm);
    const {store} = createCompiledPlanStore(cfg.stores.authoritative.url, cfg.stores.ephemeral.url);
    const {repo: persistence} = createTurnPersistence(cfg.stores.authoritative.url);
    return {app, server, model, store, persistence};
  })());
}

// HandoffConfig routing defaults are not wired yet (no tenant config store) — 'general'/'normal', no
// expiry (flagged, DEFERRED-AND-FLAGGED). The turn grounds reason/summary/evidence; the edge fills these.
function toHandoffRow(h: NonNullable<TurnLedger['handoff']>, now: Date): HandoffTaskRow {
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
    transitions: [{from: null, to: 'requested', by: 'prn_system', at: now.toISOString()}],
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

export async function agentTurn(request: TurnRequest): Promise<TurnResult> {
  const stopHeartbeat = startHeartbeat();
  try {
    return await runAgentTurn(request);
  } finally {
    stopHeartbeat();
  }
}

async function runAgentTurn(request: TurnRequest): Promise<TurnResult> {
  const {app, server, model, store, persistence} = await boot();
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
    deployment.capabilities.map(c => store.resolveContractCached(tenantId, c.definitionId, c.contentHash)),
  )) as unknown as CapabilityContract[];
  const policyPlan = (await store.resolvePlanCached(
    tenantId,
    deployment.policy.planId as PlanId,
    deployment.policy.contentHash,
  )) as unknown as CompiledPolicyPlan;

  // Scope-gated tool set from the engine's allowedCapabilities; envelope metadata from the contracts.
  const tools: DeciderTool[] = capabilitiesForEngine(engine.body.allowedCapabilities, capContracts, scopes).map(c => ({
    toolName: toolNameOf(c.name),
    capability: c.name,
    description: c.description,
    parameters: c.inputJsonSchema,
  }));
  const byName = new Map(capContracts.map(c => [c.name, c]));
  const executor = new PlatformToolExecutor(server, app as unknown as Context, metaSourceFrom(n => byName.get(n)));

  const decider = createModelDecider({
    model,
    objective: `${request.objective} (inbound: ${request.inbound.text ?? ''})`,
    tools,
  });

  let capturedLedger: TurnLedger | undefined;
  const startedMs = Date.now();
  const result = await runTurn(request, {
    executor,
    decider,
    policy: {plan: policyPlan, runtime: new ExpressionPolicyRuntime(builtinRegistry())},
    // Durable turn persistence (Tier 2, made ATOMIC in F3): ONE tenant-scoped transaction commits the
    // ledger, the initial handoff_tasks request, the append-only audit trail, the usage records, and an
    // event_outbox row per audit event (commit-and-publish) — a crash mid-persist leaves nothing, never
    // a ledger without its audit trail or billing record. Idempotent; a Temporal retry collapses.
    onPersist: async turnLedger => {
      capturedLedger = turnLedger;
      const now = new Date();
      const occurredAt = now.toISOString() as IsoTimestamp;
      await persistence.persistTurnAtomic(
        {
          ledger: toLedgerRows(turnLedger),
          handoff:
            turnLedger.handoff && turnLedger.handoff.conversationId
              ? toHandoffRow(turnLedger.handoff, now)
              : undefined,
          auditEvents: deriveAuditEvents(turnLedger, {principalId, conversationId, occurredAt}),
          // Usage metering (exactly-once on dedupeKey) — model tokens/cost + tool-invocation count.
          usageEvents: deriveUsageEvents(turnLedger, {principalId, occurredAt}),
        },
        {tenantId},
      );
    },
  });

  // Metrics catalogue (Tier 3.7): turn count/latency, per-tool invocation count/latency, per-gate decision
  // count — the SLO signals. Derived from the captured ledger + wall latency.
  if (capturedLedger) emitTurnMetrics(meter, capturedLedger, result.outcome, Date.now() - startedMs);

  // Structured, correlation-tagged, PII-redacting completion log (the reply is masked before export).
  turnLogger.log({
    level: 'info',
    message: 'agent turn complete',
    timestamp: new Date().toISOString(),
    correlation: correlationFromWorkspace(request.workspace, request.turnId),
    fields: {outcome: result.outcome, reply: result.reply, toolCount: result.metrics.toolCount, steps: result.steps},
  });
  return result;
}
