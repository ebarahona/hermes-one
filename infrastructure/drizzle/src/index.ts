// @platform-internal/drizzle — infrastructure (none plane).
// Postgres adapters behind the platform's repository ports (ADR-022): the content-addressed
// compiled-plan substrate, tenant-scoped runtime tables, RLS primitives, and migrations.

// Schema (Drizzle table DDL, source of truth for queries).
export * from './schema/substrate.schema.js';
export * from './schema/runtime.schema.js';
export * from './schema/audit.schema.js';
export * from './schema/tenant.schema.js';
export * from './schema/capability.schema.js';
export * from './schema/event.schema.js';
export * from './schema/substrate.zod.js';

// Tenant-scoped execution primitive + RLS self-check.
export {
  TenantAwareRepository,
  type PlatformDb,
  type PlatformTx,
} from './tenant-aware.repository.js';
export {assertNonBypassingRole, tenantGucPreflight, type RlsRolePosture} from './rls-self-check.js';

// Compiled-plan store (content-hash addressed + Redis cache-through).
export {
  DrizzleCompiledPlanStore,
  SubstrateCacheKeys,
  DEFAULT_SUBSTRATE_CACHE,
  type CompiledPlanStore,
  type SubstrateCacheConfig,
} from './adapters/compiled-plan-store.repository.js';

// Tenant-scoped runtime repositories.
export {
  DrizzleMessageRepository,
  type OutboundMessageRow,
  type InboundMessageRow,
} from './message-repository.js';
export {
  DrizzleTurnLedgerRepository,
  type TurnLedgerRows,
  type ToolExecutionRow,
  type EvidenceRow,
  type PolicyDecisionRow,
} from './turn-ledger-repository.js';
export {
  DrizzleHandoffRepository,
  type HandoffTaskRow,
} from './handoff-repository.js';
export {DrizzleAuditSink} from './audit-repository.js';
export {DrizzleUsageMeter} from './usage-repository.js';
export {DrizzleAuditQueryService} from './audit-query.js';
export {
  DrizzleTurnPersistence,
  type TurnPersistenceBundle,
} from './turn-persistence.js';
export {
  DrizzleEventOutboxRepository,
  deriveOutboxId,
  type OutboxEnqueueRow,
  type OutboxDrainResult,
} from './event-outbox-repository.js';
export {
  EventOutboxPublisherLoop,
  DEFAULT_OUTBOX_PUBLISHER_CONFIG,
  type OutboxPublisherConfig,
} from './event-outbox-publisher.js';

// Tenant-scoped substrate write repositories (authoring + deployment).
export {
  DrizzleDefinitionRepository,
  DrizzleDeploymentRepository,
  type DefinitionRow,
  type DefinitionVersionRow,
  type DeploymentRowInput,
  type DeploymentMemberInput,
} from './substrate-repository.js';

// Connection factories + convenience composition.
export {
  createPlatformDb,
  createMigratorDb,
  createCompiledPlanStore,
  createMessageRepository,
  createTurnLedgerRepository,
  createHandoffRepository,
  createAuditSink,
  createUsageMeter,
  createAuditQueryService,
  createTurnPersistence,
  createEventOutboxRepository,
  createSubstrateWrite,
  assertRlsPostureAtBoot,
  type PlatformDbHandle,
  type CompiledPlanStoreHandle,
  type MessageRepositoryHandle,
  type TurnLedgerRepositoryHandle,
  type HandoffRepositoryHandle,
  type AuditSinkHandle,
  type UsageMeterHandle,
  type AuditQueryServiceHandle,
  type TurnPersistenceHandle,
  type EventOutboxRepositoryHandle,
  type SubstrateWriteHandle,
} from './client.js';

// Migration runner.
export {runMigrations, type MigrationResult} from './migrate.js';

export const descriptor = {
  name: '@platform-internal/drizzle',
  role: 'infrastructure',
  plane: 'none',
  published: false,
  sourceDocs: ['08-data/081', 'substrate/compiled-plan-store', 'database/row-level-security'],
  governedBy: ['ADR-014', 'ADR-016', 'ADR-022'],
} as const;
