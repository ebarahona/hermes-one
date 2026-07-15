// Headless installer for the electrician vertical (Pack E) — authors the pack's five definitions
// through DefinitionRegistry.put and publishes the deployment via DeploymentService, exactly like the
// admin API does (definition/deployment controllers), but in-process for the live-turn e2e. The pack
// itself is DATA (verticals/electrician/pack.json); nothing here is electrician CODE. Returns the
// refs the workflow interpreter host (runTriage) needs to drive a turn against the vertical.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createCompiledPlanStore, createSubstrateWrite, runMigrations} from '@platform-internal/drizzle';
import {builtinRegistry} from '@platform/expression-core';
import {compileRule} from '@platform/rule-dsl';
import {compileWorkflow} from '@platform/workflow-dsl';
import {compilePolicy} from '@platform/policy-dsl';
import {DefinitionRegistry, DeploymentService, type CompileFn} from '@platform/definition-substrate';
import type {Definition, DeploymentMember, PrincipalId, SemVer, TenantId} from '@platform/contracts';

const V1 = '1.0.0' as SemVer;
const ACTOR = 'prn_pack_e' as PrincipalId;

export interface ElectricianInstall {
  tenantId: string;
  deployment: {deploymentId: string; version: string};
  workflow: {planId: string; contentHash: string};
  rule: {planId: string; contentHash: string};
  parameters: Record<string, unknown>;
}

interface PackDef {
  definitionId: string;
  kind: string;
  name: string;
  schemaRef: string;
  version: string;
  body: unknown;
}
interface Pack {
  manifest: {operatorRegistryVersion: string};
  definitions: {workflow: PackDef; agentEngine: PackDef; policy: PackDef; rules: PackDef[]; capabilities: PackDef[]};
}

function readPack(): Pack {
  return JSON.parse(readFileSync(join(process.cwd(), 'verticals/electrician/pack.json'), 'utf8'));
}

const authored = (d: PackDef, tenantId: string): Definition =>
  ({
    definitionId: d.definitionId,
    tenantId,
    kind: d.kind,
    name: d.name,
    schemaRef: d.schemaRef,
    version: d.version,
    status: 'draft',
    labels: {},
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    createdBy: ACTOR,
    body: d.body,
  }) as unknown as Definition;

/** Install the electrician pack for a tenant. Idempotent-ish: publish bumps a new version each call. */
export async function installElectricianPack(
  pgUrl: string,
  redisUrl: string,
  tenantId: string = 'tnt_elec_demo',
): Promise<ElectricianInstall> {
  await runMigrations(pgUrl);
  const {store, close: closeStore} = createCompiledPlanStore(pgUrl, redisUrl);
  const write = createSubstrateWrite(pgUrl);
  const opreg = builtinRegistry(V1);
  const compilers: Record<'workflow' | 'rule' | 'policy', CompileFn> = {
    workflow: (def, ctx) => compileWorkflow(def as never, {compilerVersion: ctx.compilerVersion, planId: ctx.planId, compiledAt: ctx.compiledAt as never}),
    rule: (def, ctx) => compileRule(def as never, {registry: opreg, compilerVersion: ctx.compilerVersion, planId: ctx.planId, compiledAt: ctx.compiledAt as never}),
    policy: (def, ctx) => compilePolicy(def as never, {registry: opreg, compilerVersion: ctx.compilerVersion, planId: ctx.planId, compiledAt: ctx.compiledAt as never}),
  };
  const registry = new DefinitionRegistry({store, definitions: write.definitions, compilers, compilerVersion: V1, now: () => '2026-07-15T00:00:00.000Z'});
  const service = new DeploymentService({store, deployments: write.deployments, now: () => '2026-07-15T00:00:00.000Z'});

  try {
    const pack = readPack();
    const d = pack.definitions;

    // Author the referenced members first (the workflow pins them by content hash).
    const eng = await registry.put(authored(d.agentEngine, tenantId), ACTOR);
    const pol = await registry.put(authored(d.policy, tenantId), ACTOR);
    const ruleResults = [];
    for (const r of d.rules) ruleResults.push({def: r, res: await registry.put(authored(r, tenantId), ACTOR)});
    const capResults = [];
    for (const c of d.capabilities) capResults.push({def: c, res: await registry.put(authored(c, tenantId), ACTOR)});

    // Resolve the workflow's PinnedRefs (definitionId → contentHash), then author it last.
    const hashOf: Record<string, string> = {[d.agentEngine.definitionId]: eng.contentHash};
    for (const {def, res} of ruleResults) hashOf[def.definitionId] = res.contentHash;
    const wfDef: PackDef = JSON.parse(JSON.stringify(d.workflow));
    const nodes = (wfDef.body as {nodes: Record<string, Record<string, unknown>>}).nodes;
    for (const node of Object.values(nodes)) {
      for (const field of ['rule', 'agentEngine', 'capability', 'workflow'] as const) {
        const ref = node[field] as {definitionId?: string; contentHash?: string} | undefined;
        if (ref && typeof ref === 'object' && ref.definitionId && hashOf[ref.definitionId]) ref.contentHash = hashOf[ref.definitionId];
      }
    }
    const wf = await registry.put(authored(wfDef, tenantId), ACTOR);

    const member = (kind: DeploymentMember['kind'], definitionId: string, planId: string | null, contentHash: string): DeploymentMember =>
      ({kind, definitionId, planId, version: V1, contentHash}) as DeploymentMember;
    const deployed = await service.publish({
      tenantId: tenantId as TenantId,
      workflow: member('workflow', d.workflow.definitionId, wf.planId, wf.contentHash),
      agentEngine: member('agent-engine', d.agentEngine.definitionId, eng.planId, eng.contentHash),
      policy: member('policy', d.policy.definitionId, pol.planId, pol.contentHash),
      rules: ruleResults.map(({def, res}) => member('rule', def.definitionId, res.planId, res.contentHash)),
      capabilities: capResults.map(({def, res}) => member('capability', def.definitionId, res.planId, res.contentHash)),
      operatorRegistryVersion: pack.manifest.operatorRegistryVersion as SemVer,
      actor: ACTOR,
    });

    return {
      tenantId,
      deployment: {deploymentId: deployed.deploymentId, version: deployed.version},
      workflow: {planId: wf.planId!, contentHash: wf.contentHash},
      rule: {planId: ruleResults[0].res.planId!, contentHash: ruleResults[0].res.contentHash},
      parameters: {},
    };
  } finally {
    await closeStore();
    await write.close();
  }
}
