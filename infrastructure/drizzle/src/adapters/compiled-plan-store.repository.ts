// Backs the storage half of the definition registry / deployment service: the content-addressed
// compiled-plan store with a Redis cache-through and mandatory contentHash verification on every
// read (ADR-014 — a hash mismatch is a hard error, never a silent fallback). compiled_plans and
// validated_contracts are content-addressed (no RLS); deployments/definitions are tenant-scoped (RLS),
// so their reads go through withTenant.
//
// Open Questions (spec gaps, flagged not resolved):
// - repository-patterns.md binds adapters as @injectable() behind a PersistenceComponent; this store is
//   wired via a composition-root factory (createCompiledPlanStore), matching the existing worker
//   composition roots. The @loopback/context binding belongs with the loopback-core component wiring.
// - CompiledPlanStore.getDeploymentWithMembers(deploymentId) takes no tenant scope, but deployments is
//   RLS-protected — so it fail-closes to null without a tenant context. resolveActiveDeploymentCached is
//   the tenant-scoped load path; getDeploymentWithMembers is for an already-scoped admin/tooling context.
import {eq} from 'drizzle-orm';
import {
  PlatformErrorException,
  type CompiledPlanBase,
  type ValidatedContractBase,
  type Deployment,
  type DeploymentMember,
  type PlanId,
  type ContentHash,
  type DefinitionId,
  type TenantId,
} from '@platform/contracts';
import {Deployment as DeploymentSchema} from '@platform/contracts';
import type {RedisClient} from '@platform-internal/redis';
import {TenantAwareRepository, type PlatformDb, type PlatformTx} from '../tenant-aware.repository.js';
import {
  compiledPlans,
  validatedContracts,
  deployments,
  deploymentMembers,
} from '../schema/substrate.schema.js';

/** Cache-key builders — the ONLY place Redis key strings are constructed (grep-able, no drift). */
export const SubstrateCacheKeys = {
  plan: (tenantId: TenantId, planId: PlanId, contentHash: ContentHash) =>
    `plan:${tenantId}:${planId}:${contentHash}`,
  contract: (tenantId: TenantId, definitionId: DefinitionId, contentHash: ContentHash) =>
    `contract:${tenantId}:${definitionId}:${contentHash}`,
  activeDeployment: (tenantId: TenantId) => `deployment:${tenantId}:active`,
} as const;

/** The read/write surface this store specifies; implements the storage half of DeploymentService. */
export interface CompiledPlanStore {
  /** Insert-only. ON CONFLICT(content_hash) DO NOTHING. Returns the (possibly pre-existing) row. */
  putCompiledPlan(plan: CompiledPlanBase, byteSize: number): Promise<{planId: PlanId; deduped: boolean}>;
  putValidatedContract(contract: ValidatedContractBase): Promise<{deduped: boolean}>;

  /** Direct PostgreSQL reads (no cache) — used by cache-miss rebuild and by admin/audit tooling. */
  getCompiledPlanByHash(contentHash: ContentHash): Promise<CompiledPlanBase | null>;
  getValidatedContractByHash(contentHash: ContentHash): Promise<ValidatedContractBase | null>;
  getDeploymentWithMembers(deploymentId: string): Promise<Deployment | null>;

  /** Cache-through reads — GET, on miss SELECT + SETEX, always hash-verified before return. */
  resolvePlanCached(tenantId: TenantId, planId: PlanId, contentHash: ContentHash): Promise<CompiledPlanBase>;
  resolveContractCached(tenantId: TenantId, definitionId: DefinitionId, contentHash: ContentHash): Promise<ValidatedContractBase>;
  resolveActiveDeploymentCached(tenantId: TenantId): Promise<Deployment>;

  /**
   * Resolve-by-pinned-ref (deployment-manifest.md `resolveVersion`, D1): the EXACT deployment a
   * conversation was pinned to, regardless of later publishes — superseded rows resolve fine
   * (immutable manifest; status is a pointer state). Tenant-scoped (RLS), no cache pointer needed:
   * the id/version IS the pin, and members re-join every resolve like the active path.
   */
  resolveDeployment(tenantId: TenantId, deploymentId: string): Promise<Deployment>;
  resolveDeploymentByVersion(tenantId: TenantId, version: string): Promise<Deployment>;

  /** Explicit invalidation. Called by publish/rollback. */
  invalidateActiveDeployment(tenantId: TenantId): Promise<void>;
}

export interface SubstrateCacheConfig {
  readonly planCacheTtlSeconds: number;
  readonly activePointerCacheTtlSeconds: number;
  readonly contractCacheTtlSeconds: number;
}

export const DEFAULT_SUBSTRATE_CACHE: SubstrateCacheConfig = {
  planCacheTtlSeconds: 86400,
  activePointerCacheTtlSeconds: 300,
  contractCacheTtlSeconds: 86400,
};

export class DrizzleCompiledPlanStore extends TenantAwareRepository implements CompiledPlanStore {
  constructor(
    db: PlatformDb,
    private readonly redis: RedisClient,
    private readonly cache: SubstrateCacheConfig = DEFAULT_SUBSTRATE_CACHE,
  ) {
    super(db);
  }

  /* ---------------------------- writes (content-addressed) ---------------------------- */

  async putCompiledPlan(plan: CompiledPlanBase, byteSize: number): Promise<{planId: PlanId; deduped: boolean}> {
    const inserted = await this.db
      .insert(compiledPlans)
      .values({
        contentHash: plan.contentHash,
        planId: plan.planId,
        definitionId: plan.definitionId,
        kind: plan.kind,
        version: plan.version,
        compilerVersion: plan.compilerVersion,
        planBody: plan,
        byteSize,
      })
      .onConflictDoNothing({target: compiledPlans.contentHash})
      .returning({planId: compiledPlans.planId});
    return {planId: plan.planId, deduped: inserted.length === 0};
  }

  async putValidatedContract(contract: ValidatedContractBase): Promise<{deduped: boolean}> {
    const inserted = await this.db
      .insert(validatedContracts)
      .values({
        contentHash: contract.contentHash,
        definitionId: contract.definitionId,
        kind: contract.kind,
        version: contract.version,
        schemaRef: contract.schemaRef,
        contractBody: contract,
      })
      .onConflictDoNothing({target: validatedContracts.contentHash})
      .returning({contentHash: validatedContracts.contentHash});
    return {deduped: inserted.length === 0};
  }

  /* ------------------------------ direct reads (no cache) ----------------------------- */

  async getCompiledPlanByHash(contentHash: ContentHash): Promise<CompiledPlanBase | null> {
    const [row] = await this.db
      .select({planBody: compiledPlans.planBody})
      .from(compiledPlans)
      .where(eq(compiledPlans.contentHash, contentHash))
      .limit(1);
    return row ? (row.planBody as CompiledPlanBase) : null;
  }

  async getValidatedContractByHash(contentHash: ContentHash): Promise<ValidatedContractBase | null> {
    const [row] = await this.db
      .select({contractBody: validatedContracts.contractBody})
      .from(validatedContracts)
      .where(eq(validatedContracts.contentHash, contentHash))
      .limit(1);
    return row ? (row.contractBody as ValidatedContractBase) : null;
  }

  /**
   * Reconstructs a Deployment under the CURRENT RLS tenant context. Called with no tenant GUC set
   * (plain platform_app) it fail-closes to null — deployments is RLS-protected. The tenant-scoped
   * load path is resolveActiveDeploymentCached; this method is for a platform-admin/tooling context
   * that has already established a tenant scope.
   */
  async getDeploymentWithMembers(deploymentId: string): Promise<Deployment | null> {
    return this.db.transaction(tx => this.reconstructDeployment(tx, deploymentId));
  }

  /* ------------------------------ cache-through reads --------------------------------- */

  async resolvePlanCached(tenantId: TenantId, planId: PlanId, contentHash: ContentHash): Promise<CompiledPlanBase> {
    const key = SubstrateCacheKeys.plan(tenantId, planId, contentHash);
    const cached = await this.redis.get(key);
    if (cached !== null) {
      const plan = JSON.parse(cached) as CompiledPlanBase;
      this.verifyHash(contentHash, plan.contentHash);
      return plan;
    }
    const plan = await this.getCompiledPlanByHash(contentHash);
    if (!plan) throw this.notFound(`compiled plan not found: ${contentHash}`);
    this.verifyHash(contentHash, plan.contentHash);
    await this.redis.setex(key, this.cache.planCacheTtlSeconds, JSON.stringify(plan));
    return plan;
  }

  async resolveContractCached(tenantId: TenantId, definitionId: DefinitionId, contentHash: ContentHash): Promise<ValidatedContractBase> {
    const key = SubstrateCacheKeys.contract(tenantId, definitionId, contentHash);
    const cached = await this.redis.get(key);
    if (cached !== null) {
      const contract = JSON.parse(cached) as ValidatedContractBase;
      this.verifyHash(contentHash, contract.contentHash);
      return contract;
    }
    const contract = await this.getValidatedContractByHash(contentHash);
    if (!contract) throw this.notFound(`validated contract not found: ${contentHash}`);
    this.verifyHash(contentHash, contract.contentHash);
    await this.redis.setex(key, this.cache.contractCacheTtlSeconds, JSON.stringify(contract));
    return contract;
  }

  async resolveActiveDeploymentCached(tenantId: TenantId): Promise<Deployment> {
    const pointerKey = SubstrateCacheKeys.activeDeployment(tenantId);
    return this.withTenant({tenantId}, async tx => {
      let deploymentId = await this.redis.get(pointerKey);
      if (deploymentId === null) {
        const [row] = await tx
          .select({id: deployments.deploymentId})
          .from(deployments)
          .where(eq(deployments.status, 'active'))
          .limit(1);
        if (!row) throw this.notFound(`no active deployment for tenant ${tenantId}`);
        deploymentId = row.id;
        // Cache the pointer only — never the joined manifest; members re-join every resolve.
        await this.redis.setex(pointerKey, this.cache.activePointerCacheTtlSeconds, deploymentId);
      }
      const deployment = await this.reconstructDeployment(tx, deploymentId);
      if (!deployment) throw this.notFound(`active deployment ${deploymentId} missing members`);
      return deployment;
    });
  }

  async resolveDeployment(tenantId: TenantId, deploymentId: string): Promise<Deployment> {
    return this.withTenant({tenantId}, async tx => {
      const deployment = await this.reconstructDeployment(tx, deploymentId);
      if (!deployment) throw this.notFound(`deployment ${deploymentId} not found for tenant ${tenantId}`);
      return deployment;
    });
  }

  async resolveDeploymentByVersion(tenantId: TenantId, version: string): Promise<Deployment> {
    return this.withTenant({tenantId}, async tx => {
      const [row] = await tx
        .select({id: deployments.deploymentId})
        .from(deployments)
        .where(eq(deployments.version, version))
        .limit(1);
      if (!row) throw this.notFound(`no deployment at version ${version} for tenant ${tenantId}`);
      const deployment = await this.reconstructDeployment(tx, row.id);
      if (!deployment) throw this.notFound(`deployment ${row.id} missing members`);
      return deployment;
    });
  }

  async invalidateActiveDeployment(tenantId: TenantId): Promise<void> {
    await this.redis.del(SubstrateCacheKeys.activeDeployment(tenantId));
  }

  /* ---------------------------------- internals --------------------------------------- */

  private async reconstructDeployment(tx: PlatformTx, deploymentId: string): Promise<Deployment | null> {
    const [dep] = await tx
      .select()
      .from(deployments)
      .where(eq(deployments.deploymentId, deploymentId))
      .limit(1);
    if (!dep) return null;

    const memberRows = await tx
      .select()
      .from(deploymentMembers)
      .where(eq(deploymentMembers.deploymentId, deploymentId));

    const toMember = (r: typeof memberRows[number]): DeploymentMember => ({
      kind: r.kind,
      definitionId: r.definitionId as DefinitionId,
      planId: (r.planId as PlanId | null),
      version: r.version as DeploymentMember['version'],
      contentHash: r.contentHash as ContentHash,
    });
    const ofKind = (k: DeploymentMember['kind']) =>
      memberRows.filter(r => r.kind === k).sort((a, b) => a.seq - b.seq);

    const single = (k: DeploymentMember['kind']): DeploymentMember => {
      const [m] = ofKind(k);
      if (!m) throw this.notFound(`deployment ${deploymentId} is missing its ${k} member`);
      return toMember(m);
    };

    // Reconstruct exactly the Deployment contract shape and validate it — a malformed manifest is a
    // hard error, never a silently partial return.
    return DeploymentSchema.parse({
      deploymentId: dep.deploymentId,
      tenantId: dep.tenantId,
      version: dep.version,
      status: dep.status,
      workflow: single('workflow'),
      agentEngine: single('agent-engine'),
      policy: single('policy'),
      rules: ofKind('rule').map(toMember),
      capabilities: ofKind('capability').map(toMember),
      operatorRegistryVersion: dep.operatorRegistryVersion,
      createdAt: dep.createdAt.toISOString(),
      createdBy: dep.createdBy,
      notes: dep.notes ?? undefined,
    });
  }

  private verifyHash(expected: ContentHash, got: ContentHash): void {
    if (expected !== got) {
      throw new PlatformErrorException({
        category: 'internal',
        code: 'internal_error',
        message: `content hash mismatch: expected ${expected}, got ${got}`,
        issues: [],
        retryable: false,
        httpStatus: 500,
      });
    }
  }

  private notFound(message: string): PlatformErrorException {
    return new PlatformErrorException({
      category: 'not-found',
      code: 'not_found',
      message,
      issues: [],
      retryable: false,
      httpStatus: 404,
    });
  }
}
