// PlatformBindings — every edge/data-plane (`@loopback/context`) binding key, transcribed from
// loopback/binding-key-registry.md. All keys are strings of the form `platform.<area>.<name>`.
//
// Spec deltas (flagged, not improvised):
// - The spec places this file in `packages/agent-platform-internal/bindings`; this repo hosts it in
//   `components/loopback-core` (edge) so `@platform/contracts` stays free of any container dependency
//   (BindingKey.create is an @loopback/context API; contracts is plane-neutral).
// - Keys whose PORT TYPE does not exist yet are NOT declared (declaring them typed `unknown` would
//   invite untyped resolution). Pending, with their spec type owner:
//   TEMPORAL_* (`@platform/temporal` — Pack B types unbuilt), QDRANT (`VectorStore` port unbuilt),
//   TRACER (OTel SDK pending, OB5), TENANT_RESOLVER / TENANT_RUNTIME_* (tenant registry, CT1/CT2),
//   MEMORY_PROVIDER (memory pack unbuilt), AGENTBACK_BRIDGE (`AgentBackBridge` type pack-owned),
//   WORKFLOW_VERSION_ANALYZER + admin/config-subtree keys (their packs are unbuilt).
// - `platform.data.*` repository keys: `binding-key-registry.md` defers these to the database pack's
//   own registry; the canonical ones documented there (`event-outbox-repository`,
//   `event-outbox-publisher`, `handoff-repository`) are used verbatim; the rest follow the same
//   `platform.data.<name>` grammar (flagged).
import {BindingKey} from '@loopback/context';
import type {
  AuditSink,
  CapabilityRegistry,
  PolicyRuntime,
  Principal,
  RuleRuntime,
  ToolExecutor,
  UsageMeter,
  WorkflowRuntime,
  Logger,
  Meter,
  EventOutboxRepository,
  EventPublisher,
} from '@platform/contracts';
import type {CapabilityInvoker, ProviderRegistry, ProviderResolver} from '@platform/capability-contract';
import type {
  CompiledPlanStore,
  DrizzleHandoffRepository,
  DrizzleMessageRepository,
  DrizzleTurnPersistence,
  PlatformDbHandle,
} from '@platform-internal/drizzle';
import type {RedisClient} from '@platform-internal/redis';
import type {HermesConfig} from '@platform-internal/config';

/**
 * PlatformBindings — every edge/data-plane (`@loopback/context`) binding key.
 * All keys are strings of the form `platform.<area>.<name>`.
 * @public
 */
export namespace PlatformBindings {
  // ── capability (ADR-020) ─────────────────────────────────────────────────
  export const CAPABILITY_REGISTRY = BindingKey.create<CapabilityRegistry>(
    'platform.capability.registry',
  );
  export const CAPABILITY_RESOLVER = BindingKey.create<ProviderResolver>(
    'platform.capability.resolver',
  );
  export const PROVIDER_REGISTRY = BindingKey.create<ProviderRegistry>('platform.provider.registry');
  /** Grammar-derived (flagged): the resolve+execute path over the registry/resolver (ADR-018). */
  export const CAPABILITY_INVOKER = BindingKey.create<CapabilityInvoker>('platform.capability.invoker');

  // ── policy runtime (ADR-019) ─────────────────────────────────────────────
  export const POLICY_RUNTIME = BindingKey.create<PolicyRuntime>('platform.policy.runtime');

  // ── rule runtime (ADR-015) ──────────────────────────────────────────────
  export const RULE_RUNTIME = BindingKey.create<RuleRuntime>('platform.rule.runtime');

  // ── workflow runtime (ADR-014) ────────────────────────────────────────────
  export const WORKFLOW_RUNTIME = BindingKey.create<WorkflowRuntime>('platform.workflow.runtime');

  // ── tool executor (ADR-018, wraps agentback invokeTool) ──────────────────
  export const TOOL_EXECUTOR = BindingKey.create<ToolExecutor>('platform.tool.executor');

  // ── audit + usage metering (T7) ───────────────────────────────────────────
  export const AUDIT_SINK = BindingKey.create<AuditSink>('platform.audit.sink');
  export const USAGE_METER = BindingKey.create<UsageMeter>('platform.usage.meter');

  // ── datasources (singletons) ────────────────────────────────────────────
  /** Spec type `PostgresDatabase` (@platform/data, unbuilt) — the repo's PlatformDbHandle carries
   *  the drizzle db + pool the lifecycle observer needs (flagged). */
  export const POSTGRES = BindingKey.create<PlatformDbHandle>('platform.data.postgres');
  export const REDIS = BindingKey.create<RedisClient>('platform.data.redis');

  // ── repository / store ports (database-pack grammar `platform.data.<name>`) ──
  export const COMPILED_PLAN_STORE = BindingKey.create<CompiledPlanStore>(
    'platform.data.compiled-plan-store',
  );
  export const MESSAGE_REPOSITORY = BindingKey.create<DrizzleMessageRepository>(
    'platform.data.message-repository',
  );
  export const TURN_PERSISTENCE = BindingKey.create<DrizzleTurnPersistence>(
    'platform.data.turn-persistence',
  );
  export const HANDOFF_REPOSITORY = BindingKey.create<DrizzleHandoffRepository>(
    'platform.data.handoff-repository',
  );
  export const EVENT_OUTBOX_REPOSITORY = BindingKey.create<EventOutboxRepository>(
    'platform.data.event-outbox-repository',
  );
  export const EVENT_OUTBOX_PUBLISHER = BindingKey.create<EventPublisher>(
    'platform.data.event-outbox-publisher',
  );

  // ── telemetry ───────────────────────────────────────────────────────────
  export const METER = BindingKey.create<Meter>('platform.telemetry.meter');
  export const LOGGER = BindingKey.create<Logger>('platform.telemetry.logger');

  // ── tenant context (tenant scope) ───────────────────────────────────────
  export const TENANT_ID = BindingKey.create<string>('platform.tenant.id');

  // ── request context (request scope) ─────────────────────────────────────
  export const REQUEST_PRINCIPAL = BindingKey.create<Principal>('platform.request.principal');
  export const CORRELATION_ID = BindingKey.create<string>('platform.request.correlation-id');
  export const REQUEST_LOCALE = BindingKey.create<string>('platform.request.locale');
  export const REQUEST_CHANNEL = BindingKey.create<string>('platform.request.channel');

  // ── configuration subtree (immutable after boot, secrets lazy) ──────────
  export const CONFIG = BindingKey.create<HermesConfig>('platform.config.root');
}

/**
 * Derive a tenant-partitioned edge key. Never hand-write `platform.tenants.<id>.*`.
 * @public
 */
export function tenantKey<T>(tenantId: string, name: string): BindingKey<T> {
  return BindingKey.create<T>(`platform.tenants.${tenantId}.${name}`);
}

/**
 * Extension-point ids (extension-point-registry.md / component-registry.md `consumesExtensionPoints`).
 * Provider adapters are contributed as bindings tagged `{extensionFor: PROVIDER_ADAPTERS}` and
 * discovered by the CapabilityRegistryComponent (the LB4 extension-point idiom).
 */
export const PlatformExtensionPoints = {
  PROVIDER_ADAPTERS: 'platform.extensions.providerAdapters',
} as const;
