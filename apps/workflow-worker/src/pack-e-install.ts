// Headless installer for ANY vertical pack — authors the pack's definitions through
// DefinitionRegistry.put and publishes the deployment via DeploymentService, exactly like the admin
// API does (definition/deployment controllers), but in-process for the live-turn e2e.
//
// Nothing here is vertical-specific: the pack is DATA (ADR-013) and the installer only walks it. It
// was previously hardcoded to verticals/electrician/pack.json, which meant the NEXT vertical needed a
// code edit — undercutting the very claim the pack exists to demonstrate. The pack path is now a
// parameter; `installElectricianPack` remains as a thin, named convenience over it.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  createCompiledPlanStore,
  createSubstrateWrite,
  createVerticalPackInstallations,
  runMigrations,
} from '@hermes-one/drizzle';
import {builtinRegistry} from '@hermes-one/expression-core';
import {compileRule} from '@hermes-one/rule-dsl';
import {compileWorkflow} from '@hermes-one/workflow-dsl';
import {compilePolicy} from '@hermes-one/policy-dsl';
import {
  DefinitionRegistry,
  DeploymentService,
  type CompileFn,
} from '@hermes-one/definition-substrate';
import type {
  Definition,
  DeploymentMember,
  PrincipalId,
  SemVer,
  TenantId,
} from '@hermes-one/contracts';

const V1 = '1.0.0' as SemVer;
const ACTOR = 'prn_pack_e' as PrincipalId;

export interface VerticalInstall {
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
  manifest: {
    packId: string;
    packVersion: string;
    operatorRegistryVersion: string;
  };
  definitions: {
    workflow: PackDef;
    agentEngine: PackDef;
    policy: PackDef;
    rules: PackDef[];
    capabilities: PackDef[];
  };
}

/** Path of the electrician pack, relative to the repo root — the seed vertical shipped in-tree. */
export const ELECTRICIAN_PACK = 'verticals/electrician/pack.json';

function readPack(packPath: string): Pack {
  return JSON.parse(readFileSync(join(process.cwd(), packPath), 'utf8'));
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

/** Install a vertical pack for a tenant. Idempotent-ish: publish bumps a new version each call. */
export async function installVerticalPack(
  pgUrl: string,
  redisUrl: string,
  tenantId: string,
  packPath: string = ELECTRICIAN_PACK,
): Promise<VerticalInstall> {
  await runMigrations(pgUrl);
  const {store, close: closeStore} = createCompiledPlanStore(pgUrl, redisUrl);
  const write = createSubstrateWrite(pgUrl);
  const opreg = builtinRegistry(V1);
  const compilers: Record<'workflow' | 'rule' | 'policy', CompileFn> = {
    workflow: (def, ctx) =>
      compileWorkflow(def as never, {
        compilerVersion: ctx.compilerVersion,
        planId: ctx.planId,
        compiledAt: ctx.compiledAt as never,
      }),
    rule: (def, ctx) =>
      compileRule(def as never, {
        registry: opreg,
        compilerVersion: ctx.compilerVersion,
        planId: ctx.planId,
        compiledAt: ctx.compiledAt as never,
      }),
    policy: (def, ctx) =>
      compilePolicy(def as never, {
        registry: opreg,
        compilerVersion: ctx.compilerVersion,
        planId: ctx.planId,
        compiledAt: ctx.compiledAt as never,
      }),
  };
  const registry = new DefinitionRegistry({
    store,
    definitions: write.definitions,
    compilers,
    compilerVersion: V1,
    now: () => '2026-07-15T00:00:00.000Z',
  });
  const service = new DeploymentService({
    store,
    deployments: write.deployments,
    now: () => '2026-07-15T00:00:00.000Z',
  });

  try {
    const pack = readPack(packPath);
    const d = pack.definitions;

    // Author the referenced members first (the workflow pins them by content hash).
    const eng = await registry.put(authored(d.agentEngine, tenantId), ACTOR);
    const pol = await registry.put(authored(d.policy, tenantId), ACTOR);
    const ruleResults = [];
    for (const r of d.rules)
      ruleResults.push({
        def: r,
        res: await registry.put(authored(r, tenantId), ACTOR),
      });
    const capResults = [];
    for (const c of d.capabilities)
      capResults.push({
        def: c,
        res: await registry.put(authored(c, tenantId), ACTOR),
      });

    // Resolve the workflow's PinnedRefs (definitionId → contentHash), then author it last.
    const hashOf: Record<string, string> = {
      [d.agentEngine.definitionId]: eng.contentHash,
    };
    for (const {def, res} of ruleResults)
      hashOf[def.definitionId] = res.contentHash;
    const wfDef: PackDef = JSON.parse(JSON.stringify(d.workflow));
    const nodes = (
      wfDef.body as {nodes: Record<string, Record<string, unknown>>}
    ).nodes;
    for (const node of Object.values(nodes)) {
      for (const field of [
        'rule',
        'agentEngine',
        'capability',
        'workflow',
      ] as const) {
        const ref = node[field] as
          {definitionId?: string; contentHash?: string} | undefined;
        if (
          ref &&
          typeof ref === 'object' &&
          ref.definitionId &&
          hashOf[ref.definitionId]
        )
          ref.contentHash = hashOf[ref.definitionId];
      }
    }
    const wf = await registry.put(authored(wfDef, tenantId), ACTOR);

    const member = (
      kind: DeploymentMember['kind'],
      definitionId: string,
      planId: string | null,
      contentHash: string,
    ): DeploymentMember =>
      ({
        kind,
        definitionId,
        planId,
        version: V1,
        contentHash,
      }) as DeploymentMember;
    const deployed = await service.publish({
      tenantId: tenantId as TenantId,
      workflow: member(
        'workflow',
        d.workflow.definitionId,
        wf.planId,
        wf.contentHash,
      ),
      agentEngine: member(
        'agent-engine',
        d.agentEngine.definitionId,
        eng.planId,
        eng.contentHash,
      ),
      policy: member(
        'policy',
        d.policy.definitionId,
        pol.planId,
        pol.contentHash,
      ),
      rules: ruleResults.map(({def, res}) =>
        member('rule', def.definitionId, res.planId, res.contentHash),
      ),
      capabilities: capResults.map(({def, res}) =>
        member('capability', def.definitionId, res.planId, res.contentHash),
      ),
      operatorRegistryVersion: pack.manifest.operatorRegistryVersion as SemVer,
      actor: ACTOR,
    });

    // Record the installation (tenant.vertical_pack_installations, ADR-013/CT2): which pack, which
    // version, which definitions it minted — so "what packs does this tenant run?" is a query.
    const installs = createVerticalPackInstallations(pgUrl);
    try {
      await installs.repo.record({
        installationId: `vpi_${tenantId}_${pack.manifest.packId}`.replace(
          /[^a-zA-Z0-9_]/g,
          '_',
        ),
        tenantId: tenantId as TenantId,
        packId: pack.manifest.packId,
        packVersion: pack.manifest.packVersion,
        status: 'active',
        installedDefinitions: [
          {
            kind: d.workflow.kind,
            definitionId: d.workflow.definitionId,
            version: d.workflow.version,
          },
          {
            kind: d.agentEngine.kind,
            definitionId: d.agentEngine.definitionId,
            version: d.agentEngine.version,
          },
          {
            kind: d.policy.kind,
            definitionId: d.policy.definitionId,
            version: d.policy.version,
          },
          ...d.rules.map(r => ({
            kind: r.kind,
            definitionId: r.definitionId,
            version: r.version,
          })),
          ...d.capabilities.map(c => ({
            kind: c.kind,
            definitionId: c.definitionId,
            version: c.version,
          })),
        ],
        installedBy: ACTOR,
      });
    } finally {
      await installs.close();
    }

    return {
      tenantId,
      deployment: {
        deploymentId: deployed.deploymentId,
        version: deployed.version,
      },
      workflow: {planId: wf.planId!, contentHash: wf.contentHash},
      rule: {
        planId: ruleResults[0].res.planId!,
        contentHash: ruleResults[0].res.contentHash,
      },
      parameters: {},
    };
  } finally {
    await closeStore();
    await write.close();
  }
}

/**
 * The electrician vertical — the seed vertical, kept as a named entry point for the e2es.
 * A new vertical needs NO new installer: call installVerticalPack with its pack path.
 */
export function installElectricianPack(
  pgUrl: string,
  redisUrl: string,
  tenantId = 'tnt_elec_demo',
): Promise<VerticalInstall> {
  return installVerticalPack(pgUrl, redisUrl, tenantId, ELECTRICIAN_PACK);
}
