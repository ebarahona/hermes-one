// Integration test for the real substrate lifecycle (live PG + Redis): author 5 definitions through
// DefinitionRegistry.put (workflow/rule/policy compiled; capability/agent-engine validated), publish a
// deployment through DeploymentService.publish, and resolve it back — resolveActive + resolvePlan
// (hash-verified). Proves the lifecycle replaces the direct putCompiledPlan seeding.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {loadConfig} from '@platform-internal/config';
import {
  runMigrations,
  createCompiledPlanStore,
  createSubstrateWrite,
  createMigratorDb,
  type CompiledPlanStoreHandle,
  type PlatformDbHandle,
  type SubstrateWriteHandle,
} from '@platform-internal/drizzle';
import {builtinRegistry} from '@platform/expression-core';
import {compileRule} from '@platform/rule-dsl';
import {compileWorkflow} from '@platform/workflow-dsl';
import {compilePolicy} from '@platform/policy-dsl';
import {
  DefinitionRegistry,
  DeploymentService,
  type CompileFn,
} from '@platform/definition-substrate';
import type {
  Definition,
  DeploymentMember,
  PlanId,
  PrincipalId,
  SemVer,
  TenantId,
} from '@platform/contracts';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const REDIS = cfg.stores.ephemeral.url;
const TENANT = 'tnt_life' as TenantId;
const ACTOR = 'prn_life' as PrincipalId;
const V1 = '1.0.0' as SemVer;
const opreg = builtinRegistry(V1);

let owner: PlatformDbHandle["pool"];
let ownerH: PlatformDbHandle;
let store: CompiledPlanStoreHandle;
let write: SubstrateWriteHandle;
let registry: DefinitionRegistry;
let service: DeploymentService;

const meta = (id: string, kind: Definition['kind'], name: string, body: unknown): Definition =>
  ({
    definitionId: id,
    tenantId: TENANT,
    kind,
    name,
    schemaRef: `${name}.${kind}/v1`,
    version: V1,
    status: 'draft',
    labels: {},
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    createdBy: ACTOR,
    body,
  }) as unknown as Definition;

const ruleBody = {
  branches: [{outcome: 'ok', when: {type: 'literal', value: true}}],
  defaultOutcome: 'ignore',
  parameters: [],
  requiredFacts: [],
};
const workflowBody = {
  entry: 'end',
  nodes: {end: {id: 'end', kind: 'terminal', outcome: 'completed'}},
};
const policyBody = {
  rules: [{id: 'g', site: 'preGate', appliesTo: [], when: {type: 'literal', value: false}, effect: 'deny', reason: 'x'}],
  defaultVoterVerdict: 'deny',
  parameters: [],
};
const capabilityBody = {
  name: 'sms.message.send',
  title: 'Send SMS',
  description: 'send',
  inputJsonSchema: {type: 'object'},
  outputJsonSchema: {type: 'object'},
  sideEffect: 'external',
  changedDomains: ['messaging'],
  idempotency: {required: true, keyFields: ['to'], ttlSeconds: 86400},
  confirm: false,
  requiredScope: 'sms.message.send',
  providerMapping: {providers: [{providerId: 'twilio', priority: 100}], eligibility: [], onNoProvider: 'fail'},
};
const engineBody = {
  persona: 'helpful',
  objectives: ['assist'],
  allowedCapabilities: ['sms.message.send'],
  referencedRules: [],
  model: {provider: 'local', model: 'x', temperature: 0},
  promptTemplateIds: [],
};

beforeAll(async () => {
  await runMigrations(PG);
  ownerH = createMigratorDb(PG);
  owner = ownerH.pool;
  await owner.query(`DELETE FROM substrate.deployment_members dm USING substrate.deployments d WHERE dm.deployment_id=d.deployment_id AND d.tenant_id=$1`, [TENANT]);
  await owner.query(`DELETE FROM substrate.deployments WHERE tenant_id=$1`, [TENANT]);
  const owned = `SELECT definition_id FROM substrate.definitions WHERE tenant_id=$1`;
  await owner.query(`DELETE FROM substrate.compiled_plans WHERE definition_id IN (${owned})`, [TENANT]);
  await owner.query(`DELETE FROM substrate.validated_contracts WHERE definition_id IN (${owned})`, [TENANT]);
  await owner.query(`DELETE FROM substrate.definition_versions dv USING substrate.definitions d WHERE dv.definition_id=d.definition_id AND d.tenant_id=$1`, [TENANT]);
  await owner.query(`DELETE FROM substrate.definitions WHERE tenant_id=$1`, [TENANT]);

  store = createCompiledPlanStore(PG, REDIS);
  write = createSubstrateWrite(PG);
  const compilers: Record<'workflow' | 'rule' | 'policy', CompileFn> = {
    workflow: (def, ctx) => compileWorkflow(def as never, {compilerVersion: ctx.compilerVersion, planId: ctx.planId, compiledAt: ctx.compiledAt as never}),
    rule: (def, ctx) => compileRule(def as never, {registry: opreg, compilerVersion: ctx.compilerVersion, planId: ctx.planId, compiledAt: ctx.compiledAt as never}),
    policy: (def, ctx) => compilePolicy(def as never, {registry: opreg, compilerVersion: ctx.compilerVersion, planId: ctx.planId, compiledAt: ctx.compiledAt as never}),
  };
  registry = new DefinitionRegistry({
    store: store.store,
    definitions: write.definitions,
    compilers,
    compilerVersion: V1,
    now: () => '2026-07-12T00:00:00.000Z',
  });
  service = new DeploymentService({store: store.store, deployments: write.deployments, now: () => '2026-07-12T00:00:00.000Z'});
});

afterAll(async () => {
  await store?.close();
  await write?.close();
  await ownerH?.close();
});

describe('substrate lifecycle: put → publish → resolve', () => {
  it('publishes a full deployment authored through the registry and resolves it back', async () => {
    const wf = await registry.put(meta('def_life_wf', 'workflow', 'flow', workflowBody), ACTOR);
    const rule = await registry.put(meta('def_life_rule', 'rule', 'rl', ruleBody), ACTOR);
    const pol = await registry.put(meta('def_life_pol', 'policy', 'pol', policyBody), ACTOR);
    const cap = await registry.put(meta('def_life_cap', 'capability', 'sms-send', capabilityBody), ACTOR);
    const eng = await registry.put(meta('def_life_eng', 'agent-engine', 'engine', engineBody), ACTOR);

    expect(wf.planId).not.toBeNull();
    expect(cap.planId).toBeNull(); // contract-schema: validated, not compiled
    expect(eng.planId).toBeNull();

    const member = (r: {definitionId: string; planId: PlanId | null; contentHash: string}, kind: DeploymentMember['kind']): DeploymentMember =>
      ({kind, definitionId: r.definitionId, planId: r.planId, version: V1, contentHash: r.contentHash}) as DeploymentMember;

    const ref = await service.publish({
      tenantId: TENANT,
      workflow: member(wf, 'workflow'),
      agentEngine: member(eng, 'agent-engine'),
      policy: member(pol, 'policy'),
      rules: [member(rule, 'rule')],
      capabilities: [member(cap, 'capability')],
      operatorRegistryVersion: V1,
      actor: ACTOR,
    });
    expect(ref.version).toBe('1.0.0');

    const active = await service.resolveActive(TENANT);
    expect(active.deploymentId).toBe(ref.deploymentId);
    expect(active.workflow.definitionId).toBe('def_life_wf');
    expect(active.rules).toHaveLength(1);
    expect(active.capabilities).toHaveLength(1);

    // resolvePlan is content-hash-addressed + hash-verified.
    const plan = await service.resolvePlan(ref, wf.planId as PlanId, wf.contentHash as never);
    expect(plan.contentHash).toBe(wf.contentHash);
  });

  it('a second publish bumps the version and supersedes the prior active (one active per tenant)', async () => {
    const wf = await registry.put(meta('def_life_wf', 'workflow', 'flow', workflowBody), ACTOR);
    const rule = await registry.put(meta('def_life_rule', 'rule', 'rl', ruleBody), ACTOR);
    const pol = await registry.put(meta('def_life_pol', 'policy', 'pol', policyBody), ACTOR);
    const cap = await registry.put(meta('def_life_cap', 'capability', 'sms-send', capabilityBody), ACTOR);
    const eng = await registry.put(meta('def_life_eng', 'agent-engine', 'engine', engineBody), ACTOR);
    const m = (r: {definitionId: string; planId: PlanId | null; contentHash: string}, kind: DeploymentMember['kind']): DeploymentMember =>
      ({kind, definitionId: r.definitionId, planId: r.planId, version: V1, contentHash: r.contentHash}) as DeploymentMember;

    const ref2 = await service.publish({
      tenantId: TENANT,
      workflow: m(wf, 'workflow'),
      agentEngine: m(eng, 'agent-engine'),
      policy: m(pol, 'policy'),
      rules: [m(rule, 'rule')],
      capabilities: [m(cap, 'capability')],
      operatorRegistryVersion: V1,
      actor: ACTOR,
    });
    expect(ref2.version).toBe('1.0.1');
    const active = await service.resolveActive(TENANT);
    expect(active.version).toBe('1.0.1');
    const {rows} = await owner.query(`SELECT count(*)::int AS n FROM substrate.deployments WHERE tenant_id=$1 AND status='active'`, [TENANT]);
    expect(rows[0].n).toBe(1); // exactly one active
  });

  it('rejects an invalid manifest (contract member with a non-null planId)', () => {
    const bad = service.validateManifest({
      tenantId: TENANT,
      workflow: {kind: 'workflow', definitionId: 'd', planId: 'pln_x', version: V1, contentHash: `sha256:${'0'.repeat(64)}`} as DeploymentMember,
      agentEngine: {kind: 'agent-engine', definitionId: 'e', planId: 'pln_bad', version: V1, contentHash: `sha256:${'0'.repeat(64)}`} as DeploymentMember,
      policy: {kind: 'policy', definitionId: 'p', planId: 'pln_y', version: V1, contentHash: `sha256:${'0'.repeat(64)}`} as DeploymentMember,
      rules: [],
      capabilities: [],
      operatorRegistryVersion: V1,
      actor: ACTOR,
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.some(e => e.code === 'DPL_CONTRACT_MEMBER_NON_NULL_PLAN')).toBe(true);
  });
});
