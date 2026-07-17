// DeploymentService (platform.definition.deploymentService): validate a manifest, assign the next
// per-tenant version, atomically supersede the prior active deployment and insert the new one, and
// resolve pinned plans for runtimes (Redis cache-through + mandatory contentHash verify via the store).
// Full behaviour per deployment-manifest.md; resolveVersion serves replay + audit (a specific
// historical deployment, immutable — superseded rows resolve fine).
import {
  FAMILY_OF,
  type Deployment,
  type DeploymentMember,
  type DeploymentRef,
  type ContentHash,
  type PlanId,
  type PrincipalId,
  type SemVer,
  type TenantId,
} from '@platform/contracts';
import type {DeploymentWritePort, PlanStorePort, DeploymentMemberInputLike} from './ports.js';
import {deploymentPublishedEvent} from './events.js';

export interface PublishDeploymentInput {
  tenantId: TenantId;
  workflow: DeploymentMember;
  agentEngine: DeploymentMember;
  policy: DeploymentMember;
  rules: DeploymentMember[];
  capabilities: DeploymentMember[];
  operatorRegistryVersion: SemVer;
  actor: PrincipalId;
  notes?: string;
}

export interface DeploymentValidation {
  ok: boolean;
  errors: Array<{code: string; message: string; member?: string}>;
}

const INV = {
  MEMBER_KIND: 'DPL_MEMBER_KIND',
  LOGIC_MEMBER_NULL_PLAN: 'DPL_LOGIC_MEMBER_NULL_PLAN',
  CONTRACT_MEMBER_NON_NULL_PLAN: 'DPL_CONTRACT_MEMBER_NON_NULL_PLAN',
  DUPLICATE_MEMBER: 'DPL_DUPLICATE_MEMBER',
} as const;

const planIdRuleOk = (m: DeploymentMember) =>
  FAMILY_OF[m.kind] === 'logic-dsl' ? m.planId !== null : m.planId === null;

function bumpVersion(latest: string | null): SemVer {
  if (!latest) return '1.0.0' as SemVer;
  const [maj, min, patch] = latest.split('.').map(n => Number.parseInt(n, 10));
  return `${maj}.${min}.${(patch || 0) + 1}` as SemVer;
}

export interface DeploymentServiceDeps {
  store: PlanStorePort;
  deployments: DeploymentWritePort;
  now: () => string;
  /**
   * Optional regression gate (observability/evaluation-and-cost-analytics.md): consulted with the CANDIDATE
   * deployment ref after manifest validation and BEFORE the atomic supersede+insert. Returning `pass:false`
   * ABORTS the publish (no deployment is written). Injected so this package stays decoupled from the
   * agent-plane eval runner / scalability gate — the composition wires the real check.
   */
  regressionCheck?: (candidate: DeploymentRef) => Promise<{pass: boolean; reason?: string}>;
}

export class DeploymentService {
  constructor(private readonly deps: DeploymentServiceDeps) {}

  validateManifest(input: PublishDeploymentInput): DeploymentValidation {
    const errors: DeploymentValidation['errors'] = [];
    const expect = (m: DeploymentMember, kind: DeploymentMember['kind']) => {
      if (m.kind !== kind) errors.push({code: INV.MEMBER_KIND, message: `expected ${kind} member, got ${m.kind}`, member: kind});
    };
    expect(input.workflow, 'workflow');
    expect(input.agentEngine, 'agent-engine');
    expect(input.policy, 'policy');

    const all = [input.workflow, input.agentEngine, input.policy, ...input.rules, ...input.capabilities];
    for (const m of all) {
      if (!planIdRuleOk(m)) {
        errors.push(
          FAMILY_OF[m.kind] === 'logic-dsl'
            ? {code: INV.LOGIC_MEMBER_NULL_PLAN, message: `${m.kind} member requires a non-null planId`, member: m.kind}
            : {code: INV.CONTRACT_MEMBER_NON_NULL_PLAN, message: `${m.kind} member must have a null planId`, member: m.kind},
        );
      }
    }
    const seen = new Set<string>();
    for (const m of all) {
      const key = `${m.kind}:${m.definitionId}`;
      if (seen.has(key)) errors.push({code: INV.DUPLICATE_MEMBER, message: `duplicate member ${key}`, member: m.kind});
      seen.add(key);
    }
    return {ok: errors.length === 0, errors};
  }

  async publish(input: PublishDeploymentInput): Promise<DeploymentRef> {
    const validation = this.validateManifest(input);
    if (!validation.ok) {
      throw new Error(`invalid deployment manifest: ${validation.errors.map(e => e.code).join(', ')}`);
    }
    const scope = {tenantId: input.tenantId};
    const version = bumpVersion(await this.deps.deployments.latestVersion(scope));
    const deploymentId = `dpl_${input.tenantId.replace(/[^a-z0-9]/gi, '')}_${version.replace(/\./g, '')}`;

    const toRow = (m: DeploymentMember, seq: number): DeploymentMemberInputLike => ({
      kind: m.kind,
      seq,
      definitionId: m.definitionId,
      planId: m.planId,
      version: m.version,
      contentHash: m.contentHash,
    });
    const members: DeploymentMemberInputLike[] = [
      toRow(input.workflow, 0),
      toRow(input.agentEngine, 0),
      toRow(input.policy, 0),
      ...input.rules.map((m, i) => toRow(m, i)),
      ...input.capabilities.map((m, i) => toRow(m, i)),
    ];

    // Regression gate: run the golden-conversation suite (+ scalability KPIs) against the candidate before
    // committing. A required-case or KPI regression blocks the publish — nothing is written.
    if (this.deps.regressionCheck) {
      const candidate = {deploymentId, tenantId: input.tenantId, version} as DeploymentRef;
      const gate = await this.deps.regressionCheck(candidate);
      if (!gate.pass) {
        throw new Error(`deployment blocked by regression gate: ${gate.reason ?? 'required golden case(s) failed'}`);
      }
    }

    await this.deps.deployments.publish(
      {deploymentId, version, operatorRegistryVersion: input.operatorRegistryVersion, notes: input.notes, createdBy: input.actor},
      members,
      scope,
      // deployment.published rides the SAME transaction as the deployment rows (commit-and-publish).
      [
        deploymentPublishedEvent({
          tenantId: input.tenantId,
          actor: input.actor,
          deploymentId,
          version,
          operatorRegistryVersion: input.operatorRegistryVersion,
          memberCount: members.length,
          occurredAt: this.deps.now() as never,
        }),
      ],
    );
    await this.deps.store.invalidateActiveDeployment(input.tenantId);
    return {deploymentId, tenantId: input.tenantId, version} as DeploymentRef;
  }

  resolveActive(tenantId: TenantId): Promise<Deployment> {
    return this.deps.store.resolveActiveDeploymentCached(tenantId);
  }

  /** A specific historical deployment (immutable) — used by replay + audit (deployment-manifest.md). */
  resolveVersion(tenantId: TenantId, version: SemVer): Promise<Deployment> {
    return this.deps.store.resolveDeploymentByVersion(tenantId, version);
  }

  resolvePlan(ref: DeploymentRef, planId: PlanId, contentHash: ContentHash) {
    return this.deps.store.resolvePlanCached(ref.tenantId, planId, contentHash);
  }

  async rollback(tenantId: TenantId, toVersion: SemVer, actor: PrincipalId): Promise<DeploymentRef> {
    const scope = {tenantId};
    const version = bumpVersion(await this.deps.deployments.latestVersion(scope));
    const deploymentId = `dpl_${tenantId.replace(/[^a-z0-9]/gi, '')}_${version.replace(/\./g, '')}`;
    await this.deps.deployments.repointActive(
      {deploymentId, version, operatorRegistryVersion: '0.0.0' as SemVer, createdBy: actor},
      toVersion,
      scope,
    );
    await this.deps.store.invalidateActiveDeployment(tenantId);
    return {deploymentId, tenantId, version} as DeploymentRef;
  }
}
