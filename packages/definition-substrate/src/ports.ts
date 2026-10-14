// Structural ports the lifecycle depends on (implemented by @platform-internal/drizzle at the
// composition root). Declared here so the published @platform/definition-substrate package stays free
// of any infrastructure dependency — the concrete Drizzle repositories match these shapes structurally.
import type {
  AuditEvent,
  CompiledPlanBase,
  ContentHash,
  Deployment,
  PlanId,
  TenantId,
  TenantScope,
  ValidatedContractBase,
} from '@platform/contracts';

export interface PlanStorePort {
  putCompiledPlan(plan: CompiledPlanBase, byteSize: number): Promise<{planId: PlanId; deduped: boolean}>;
  putValidatedContract(contract: ValidatedContractBase): Promise<{deduped: boolean}>;
  getCompiledPlanByHash(contentHash: ContentHash): Promise<CompiledPlanBase | null>;
  getValidatedContractByHash(contentHash: ContentHash): Promise<ValidatedContractBase | null>;
  resolvePlanCached(tenantId: TenantId, planId: PlanId, contentHash: ContentHash): Promise<CompiledPlanBase>;
  resolveActiveDeploymentCached(tenantId: TenantId): Promise<Deployment>;
  /** Resolve-by-pinned-ref (`resolveVersion`) — superseded rows resolve fine. */
  resolveDeployment(tenantId: TenantId, deploymentId: string): Promise<Deployment>;
  resolveDeploymentByVersion(tenantId: TenantId, version: string): Promise<Deployment>;
  invalidateActiveDeployment(tenantId: TenantId): Promise<void>;
}

export interface DefinitionRowLike {
  definitionId: string;
  kind: 'workflow' | 'rule' | 'policy' | 'capability' | 'agent-engine';
  name: string;
  schemaRef: string;
  currentVersion: string;
  status: 'draft' | 'validated' | 'compiled' | 'published' | 'deployed' | 'retired';
  labels?: Record<string, string>;
  createdBy: string;
}

export interface DefinitionVersionRowLike {
  definitionId: string;
  version: string;
  contentHash: string;
  family: 'logic-dsl' | 'contract-schema';
  status: 'validated' | 'compiled' | 'published' | 'deployed' | 'retired';
  body: unknown;
  compilerVersion?: string | null;
  diagnostics?: unknown[];
  createdBy: string;
}

export interface DefinitionWritePort {
  /**
   * Upsert identity + insert the version row. `events` (audit + their outbox envelopes) commit in the
   * SAME transaction — and are written ONLY when the version row was NEWLY inserted, so an idempotent
   * re-put of identical content emits nothing (the billing rule: enqueue only when inserted). A crash
   * mid-write leaves NOTHING: no published version without its audit trail, no audit row whose event
   * never entered the outbox.
   */
  putDefinition(
    def: DefinitionRowLike,
    version: DefinitionVersionRowLike,
    scope: TenantScope,
    events?: AuditEvent[],
  ): Promise<{versionInserted: boolean}>;
  getDefinition(definitionId: string, scope: TenantScope): Promise<DefinitionRowLike | null>;
}

export interface DeploymentRowInputLike {
  deploymentId: string;
  version: string;
  operatorRegistryVersion: string;
  notes?: string;
  createdBy: string;
}

export interface DeploymentMemberInputLike {
  kind: 'workflow' | 'agent-engine' | 'policy' | 'rule' | 'capability';
  seq: number;
  definitionId: string;
  planId: string | null;
  version: string;
  contentHash: string;
}

export interface DeploymentWritePort {
  latestVersion(scope: TenantScope): Promise<string | null>;
  /** `events` commit in the SAME transaction as the deployment rows (commit-and-publish, F3 rule). */
  publish(
    dep: DeploymentRowInputLike,
    members: DeploymentMemberInputLike[],
    scope: TenantScope,
    events?: AuditEvent[],
  ): Promise<void>;
  repointActive(newDep: DeploymentRowInputLike, fromVersion: string, scope: TenantScope): Promise<void>;
}
