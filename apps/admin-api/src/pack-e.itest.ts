// Electrician pack (vertical) — the vertical-as-DATA proof (ADR-013). Reads the electrician pack
// (verticals/electrician/pack.json — pure data, no industry code) and installs it for a demo tenant
// THROUGH THE ADMIN API we built: author each of the five definitions via PUT /v1/definitions/{id},
// then publish the manifest via POST /v1/deployments. Asserts the resulting active deployment
// reconstructs with the electrician's own members — i.e. the platform runs a real vertical purely
// from data. Needs the compose PG stack (no LLM; the inbound turn is the separate pack-e.e2e.ts).
import 'reflect-metadata';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@hermes-one/config';
import type {PlatformRestApplication} from '@hermes-one/loopback-core';
import type {ApiKeySeed} from '@hermes-one/auth';
import type {PrincipalId, Scope, TenantId} from '@hermes-one/contracts';
import {AdminApiRoot} from './root.js';

const TENANT = 'tnt_elec_demo' as TenantId;
const KEY = 'itest-pack-e';

interface PackDef {
  definitionId: string;
  kind: string;
  name: string;
  schemaRef: string;
  version: string;
  body: unknown;
}
interface Pack {
  manifest: {packId: string; operatorRegistryVersion: string};
  definitions: {
    workflow: PackDef;
    agentEngine: PackDef;
    policy: PackDef;
    rules: PackDef[];
    capabilities: PackDef[];
  };
}

const pack: Pack = JSON.parse(
  readFileSync(join(process.cwd(), 'verticals/electrician/pack.json'), 'utf8'),
);

let app: PlatformRestApplication;
let base: string;
let owner: Pool;

async function cleanup(): Promise<void> {
  const c = await owner.connect();
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
    await c.query(
      `DELETE FROM substrate.deployment_members dm USING substrate.deployments d WHERE dm.deployment_id=d.deployment_id AND d.tenant_id=$1`,
      [TENANT],
    );
    await c.query(`DELETE FROM substrate.deployments WHERE tenant_id=$1`, [
      TENANT,
    ]);
    await c.query(
      `DELETE FROM substrate.compiled_plans WHERE definition_id IN (SELECT definition_id FROM substrate.definitions WHERE tenant_id=$1)`,
      [TENANT],
    );
    await c.query(
      `DELETE FROM substrate.validated_contracts WHERE definition_id IN (SELECT definition_id FROM substrate.definitions WHERE tenant_id=$1)`,
      [TENANT],
    );
    await c.query(
      `DELETE FROM substrate.definition_versions dv USING substrate.definitions d WHERE dv.definition_id=d.definition_id AND d.tenant_id=$1`,
      [TENANT],
    );
    await c.query(`DELETE FROM substrate.definitions WHERE tenant_id=$1`, [
      TENANT,
    ]);
  } finally {
    c.release();
  }
}

const key = (k: string, scopes: Scope[]): ApiKeySeed => ({
  key: k,
  record: {
    keyId: 'apk_pack_e',
    tenantId: TENANT,
    principalId: 'prn_pack_e' as PrincipalId,
    scopes,
    status: 'active',
    expiresAt: null,
  },
});

interface Pick {
  kind: string;
  definitionId: string;
  planId: string | null;
  version: string;
  contentHash: string;
}

beforeAll(async () => {
  const loaded = loadConfig();
  owner = new Pool({connectionString: loaded.stores.authoritative.url, max: 2});
  await cleanup();

  const cfg = {...loaded, api: {...loaded.api, port: 0}};
  const root = new AdminApiRoot(cfg, {
    apiKeySeeds: [
      key(KEY, [
        'definition.write',
        'deployment.publish',
        'deployment.read',
      ] as Scope[]),
    ],
  });
  app = root.createApp();
  root.bindPorts(app);
  root.registerComponents(app);
  await app.start();
  base = app.restServer.url!;
});

afterAll(async () => {
  await app?.stop();
  if (owner) {
    await cleanup();
    await owner.end();
  }
});

const putDef = async (d: PackDef): Promise<Pick> => {
  const res = await fetch(`${base}/v1/definitions/${d.definitionId}`, {
    method: 'PUT',
    headers: {'x-api-key': KEY, 'content-type': 'application/json'},
    body: JSON.stringify({
      tenantId: TENANT,
      kind: d.kind,
      name: d.name,
      schemaRef: d.schemaRef,
      version: d.version,
      body: d.body,
    }),
  });
  if (res.status !== 200)
    throw new Error(
      `PUT ${d.definitionId} (${d.kind}) → ${res.status}: ${await res.text()}`,
    );
  const r = (await res.json()) as {
    definitionId: string;
    planId: string | null;
    version: string;
    contentHash: string;
  };
  return {
    kind: d.kind,
    definitionId: r.definitionId,
    planId: r.planId,
    version: r.version,
    contentHash: r.contentHash,
  };
};

describe('electrician pack — installs from data (live)', () => {
  it('authors all five definitions, publishes, and the active deployment reconstructs the vertical', async () => {
    // Author each family through the admin API — this is a REAL vertical, authored as data.
    // The workflow pins its siblings (rule, agent-engine) by CONTENT HASH, so author them first,
    // resolve the workflow's PinnedRefs, then author the workflow last — exactly what a real pack
    // installer does.
    const d = pack.definitions;
    const agentEngine = await putDef(d.agentEngine);
    const policy = await putDef(d.policy);
    const rules: Pick[] = [];
    for (const r of d.rules) rules.push(await putDef(r));
    const capabilities: Pick[] = [];
    for (const c of d.capabilities) capabilities.push(await putDef(c));

    const hashOf: Record<string, string> = {};
    for (const p of [agentEngine, policy, ...rules, ...capabilities])
      hashOf[p.definitionId] = p.contentHash;
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
        ) {
          ref.contentHash = hashOf[ref.definitionId];
        }
      }
    }
    const workflow = await putDef(wfDef);

    // The logic-DSL members compiled to plans; the contract-schema members did not.
    expect(workflow.planId).toMatch(/^pln_/);
    expect(policy.planId).toMatch(/^pln_/);
    expect(agentEngine.planId).toBeNull();
    expect(capabilities[0].planId).toBeNull();

    // Publish the manifest via the admin deployment path.
    const manifest = {
      tenantId: TENANT,
      workflow,
      agentEngine,
      policy,
      rules,
      capabilities,
      operatorRegistryVersion: pack.manifest.operatorRegistryVersion,
      notes: 'electrician pack install',
    };
    const pub = await fetch(`${base}/v1/deployments`, {
      method: 'POST',
      headers: {'x-api-key': KEY, 'content-type': 'application/json'},
      body: JSON.stringify(manifest),
    });
    expect(pub.status).toBe(200);
    const ref = (await pub.json()) as {deploymentId: string; tenantId: string};
    expect(ref.tenantId).toBe(TENANT);

    // The active deployment reconstructs from the content-addressed store with the electrician's members.
    const active = await fetch(
      `${base}/v1/deployments/active?tenantId=${TENANT}`,
      {headers: {'x-api-key': KEY}},
    );
    expect(active.status).toBe(200);
    const dep = (await active.json()) as {
      deploymentId: string;
      status: string;
      workflow: {definitionId: string};
      agentEngine: {definitionId: string};
      policy: {definitionId: string};
      rules: unknown[];
      capabilities: unknown[];
    };
    expect(dep.deploymentId).toBe(ref.deploymentId);
    expect(dep.status).toBe('active');
    expect(dep.workflow.definitionId).toBe('def_elec_intake');
    expect(dep.agentEngine.definitionId).toBe('def_elec_engine');
    expect(dep.policy.definitionId).toBe('def_elec_policy');
    expect(dep.rules).toHaveLength(1);
    expect(dep.capabilities).toHaveLength(1);
  });
});
