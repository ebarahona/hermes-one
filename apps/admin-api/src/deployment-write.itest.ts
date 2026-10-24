// Live-PG integration for the DeploymentController writes (Slice 9) — the full substrate lifecycle over
// admin HTTP: author (PUT) the three required members (workflow + agent-engine + policy) → preview →
// publish → READ the active deployment (200 — closes the L1a happy-path deferred in Slice 6) → rollback.
// Plus the scope/tenant gates. Uses the minimal compilable bodies from workflow-worker/lifecycle.itest.
// Needs the compose PG stack.
import 'reflect-metadata';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@hermes-one/config';
import type {PlatformRestApplication} from '@hermes-one/loopback-core';
import type {ApiKeySeed} from '@hermes-one/auth';
import type {PrincipalId, Scope, TenantId} from '@hermes-one/contracts';
import {AdminApiRoot} from './root.js';

const TENANT = 'tnt_depwrite_itest' as TenantId;
const OTHER = 'tnt_depwrite_other';
const KEY = 'itest-depwrite'; // author + publish + read
const KEY_NOPUB = 'itest-depwrite-nopub'; // read only

const key = (k: string, principalId: string, scopes: Scope[]): ApiKeySeed => ({
  key: k,
  record: {
    keyId: `apk_${principalId}`,
    tenantId: TENANT,
    principalId: principalId as PrincipalId,
    scopes,
    status: 'active',
    expiresAt: null,
  },
});

const workflowBody = {
  entry: 'end',
  nodes: {end: {id: 'end', kind: 'terminal', outcome: 'completed'}},
};
const policyBody = {
  rules: [
    {
      id: 'g',
      site: 'preGate',
      appliesTo: [],
      when: {type: 'literal', value: false},
      effect: 'deny',
      reason: 'x',
    },
  ],
  defaultVoterVerdict: 'deny',
  parameters: [],
};
const engineBody = {
  persona: 'helpful',
  objectives: ['assist'],
  allowedCapabilities: [],
  referencedRules: [],
  model: {provider: 'local', model: 'x', temperature: 0},
  promptTemplateIds: [],
};

let app: PlatformRestApplication;
let base: string;
let owner: Pool;

interface PutResult {
  definitionId: string;
  planId: string | null;
  contentHash: string;
  version: string;
}

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

let picks: {
  workflow: unknown;
  agentEngine: unknown;
  policy: unknown;
  operatorRegistryVersion: string;
  tenantId: string;
  rules: unknown[];
  capabilities: unknown[];
};

beforeAll(async () => {
  const loaded = loadConfig();
  owner = new Pool({connectionString: loaded.stores.authoritative.url, max: 2});
  await cleanup();

  const cfg = {...loaded, api: {...loaded.api, port: 0}};
  const root = new AdminApiRoot(cfg, {
    apiKeySeeds: [
      key(KEY, 'prn_dw', [
        'definition.write',
        'deployment.publish',
        'deployment.read',
      ] as Scope[]),
      key(KEY_NOPUB, 'prn_dw_nopub', ['deployment.read'] as Scope[]),
    ],
  });
  app = root.createApp();
  root.bindPorts(app);
  root.registerComponents(app);
  await app.start();
  base = app.restServer.url!;

  // Author the three required members via PUT, then assemble the manifest picks.
  const putDef = async (
    id: string,
    kind: string,
    name: string,
    body: unknown,
  ): Promise<PutResult> => {
    const res = await fetch(`${base}/v1/definitions/${id}`, {
      method: 'PUT',
      headers: {'x-api-key': KEY, 'content-type': 'application/json'},
      body: JSON.stringify({
        tenantId: TENANT,
        kind,
        name,
        schemaRef: `${name}.${kind}/v1`,
        version: '1.0.0',
        body,
      }),
    });
    if (res.status !== 200)
      throw new Error(`PUT ${id} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as PutResult;
  };
  const pick = (kind: string, r: PutResult) => ({
    kind,
    definitionId: r.definitionId,
    planId: r.planId,
    version: r.version,
    contentHash: r.contentHash,
  });
  const wf = await putDef('def_dw_wf', 'workflow', 'dw-wf', workflowBody);
  const eng = await putDef('def_dw_eng', 'agent-engine', 'dw-eng', engineBody);
  const pol = await putDef('def_dw_pol', 'policy', 'dw-pol', policyBody);
  picks = {
    tenantId: TENANT,
    workflow: pick('workflow', wf),
    agentEngine: pick('agent-engine', eng),
    policy: pick('policy', pol),
    rules: [],
    capabilities: [],
    operatorRegistryVersion: '1.0.0',
  };
});

afterAll(async () => {
  await app?.stop();
  if (owner) {
    await cleanup();
    await owner.end();
  }
});

const post = (path: string, key: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {'x-api-key': key, 'content-type': 'application/json'},
    body: JSON.stringify(body),
  });

describe('deployment writes (live) — the full author→publish→read→rollback lifecycle', () => {
  it('previews a well-formed manifest → ok:true, and a wrong-kind manifest → ok:false', async () => {
    const ok = await post('/v1/deployments/preview', KEY, picks);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as {ok: boolean}).ok).toBe(true);

    const bad = await post('/v1/deployments/preview', KEY, {
      ...picks,
      policy: {...(picks.policy as object), kind: 'workflow'},
    });
    expect(bad.status).toBe(200);
    expect(((await bad.json()) as {ok: boolean}).ok).toBe(false);
  });

  it('publishes → 200 DeploymentRef, then the active deployment reads back → 200 (closes L1a)', async () => {
    const pub = await post('/v1/deployments', KEY, picks);
    expect(pub.status).toBe(200);
    const ref = (await pub.json()) as {
      deploymentId: string;
      tenantId: string;
      version: string;
    };
    expect(ref.deploymentId).toMatch(/^dpl_/);
    expect(ref.tenantId).toBe(TENANT);

    const active = await fetch(
      `${base}/v1/deployments/active?tenantId=${TENANT}`,
      {headers: {'x-api-key': KEY}},
    );
    expect(active.status).toBe(200);
    const dep = (await active.json()) as {
      deploymentId: string;
      status: string;
      workflow: {kind: string};
      policy: {kind: string};
    };
    expect(dep.deploymentId).toBe(ref.deploymentId);
    expect(dep.status).toBe('active');
    expect(dep.workflow.kind).toBe('workflow');
    expect(dep.policy.kind).toBe('policy');
  });

  it('rolls back to the published version → 200 DeploymentRef', async () => {
    const active = (await (
      await fetch(`${base}/v1/deployments/active?tenantId=${TENANT}`, {
        headers: {'x-api-key': KEY},
      })
    ).json()) as {version: string};
    const res = await post(`/v1/deployments/${TENANT}/rollback`, KEY, {
      toVersion: active.version,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as {deploymentId: string}).deploymentId).toMatch(
      /^dpl_/,
    );
  });

  it('rejects publish without deployment.publish → 403', async () => {
    expect((await post('/v1/deployments', KEY_NOPUB, picks)).status).toBe(403);
  });

  it('rejects a manifest for another tenant → 403 (tenant boundary)', async () => {
    expect(
      (await post('/v1/deployments', KEY, {...picks, tenantId: OTHER})).status,
    ).toBe(403);
    expect(
      (await post('/v1/deployments/preview', KEY, {...picks, tenantId: OTHER}))
        .status,
    ).toBe(403);
  });

  it('rejects an unauthenticated publish → 401', async () => {
    const res = await fetch(`${base}/v1/deployments`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(picks),
    });
    expect(res.status).toBe(401);
  });
});
