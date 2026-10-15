// Live-PG integration for ProviderMappingController (ledger CT3): boots admin-api WITH Persistence and
// drives GET/PUT/DELETE .../provider-mapping with real api-key principals. Authors a capability contract
// first (PUT /v1/definitions/{id}, mirrors definition-route.itest.ts's minimal capability body), then
// proves: the contract-default fallback, the tenant-override write winning over it, revert-on-delete,
// the scope gates, the tenant boundary, and validation. Needs the compose PG stack.
import 'reflect-metadata';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@platform-internal/config';
import type {PlatformRestApplication} from '@platform-internal/loopback-core';
import type {ApiKeySeed} from '@platform-internal/auth';
import type {PrincipalId, Scope, TenantId} from '@platform/contracts';
import {AdminApiRoot} from './root.js';

const TENANT = 'tnt_pm_itest' as TenantId;
const OTHER = 'tnt_pm_other';
const CAP_NAME = 'itest.pm.mapping';
const DEF_ID = 'def_itest_pm_mapping';

const KEY_FULL = 'itest-pm-full'; // definition.write + capability.read + tenant.provider-mapping.write
const KEY_NOSCOPE = 'itest-pm-noscope';

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

// Minimal capability contract (mirrors definition-route.itest.ts's capabilityBody) — the "default"
// providerMapping the override surface falls back to when no tenant override row exists.
const defaultMapping = {
  providers: [{providerId: 'internal-default', priority: 100}],
  eligibility: [],
  onNoProvider: 'fail',
};
const capabilityBody = {
  name: CAP_NAME,
  title: 'Itest provider-mapping capability',
  description:
    'A capability used solely to exercise the provider-mapping override surface.',
  inputJsonSchema: {type: 'object', properties: {}},
  outputJsonSchema: {type: 'object', properties: {}},
  sideEffect: 'read',
  changedDomains: ['none'],
  idempotency: {required: false, keyFields: [], ttlSeconds: 86400},
  confirm: false,
  requiredScope: CAP_NAME,
  providerMapping: defaultMapping,
};

// The substrate.capability_registrations view's `capability_name` comes off `definitions.name`
// (the top-level PutDefinitionRequest field) — NOT capabilityBody.name — so the two must match
// for findContractDefault(tenantId, CAP_NAME) to resolve this row.
const putDefinitionReq = {
  tenantId: TENANT,
  kind: 'capability',
  name: CAP_NAME,
  // SchemaRef's name segment is a hyphenated slug (ADR-016 grammar), distinct from the dotted
  // capability name — e.g. `sms-send.capability/v1` for capability `sms.message.send`.
  schemaRef: 'itest-pm-mapping.capability/v1',
  version: '1.0.0',
  body: capabilityBody,
};

let app: PlatformRestApplication;
let base: string;
let owner: Pool;

async function cleanupDefinitions(): Promise<void> {
  const c = await owner.connect();
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
    await c.query(
      `DELETE FROM capability.provider_mappings WHERE tenant_id = $1`,
      [TENANT],
    );
    await c.query(
      `DELETE FROM substrate.validated_contracts WHERE definition_id = $1`,
      [DEF_ID],
    );
    await c.query(
      `DELETE FROM substrate.definition_versions WHERE definition_id = $1`,
      [DEF_ID],
    );
    await c.query(
      `DELETE FROM audit.audit_events WHERE tenant_id = $1 AND action = 'definition.published'`,
      [TENANT],
    );
    await c.query(`DELETE FROM event.event_outbox WHERE tenant_id = $1`, [
      TENANT,
    ]);
    await c.query(
      `DELETE FROM substrate.definitions WHERE definition_id = $1`,
      [DEF_ID],
    );
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  const cfg0 = loadConfig();
  owner = new Pool({connectionString: cfg0.stores.authoritative.url, max: 2});
  await cleanupDefinitions();

  const cfg = {...cfg0, api: {...cfg0.api, port: 0}};
  const root = new AdminApiRoot(cfg, {
    apiKeySeeds: [
      key(KEY_FULL, 'prn_svc_pmfull', [
        'definition.write',
        'capability.read',
        'tenant.provider-mapping.write',
      ] as Scope[]),
      key(KEY_NOSCOPE, 'prn_svc_pmnos', ['tenant.role.read'] as Scope[]),
    ],
  });
  app = root.createApp();
  root.bindPorts(app);
  root.registerComponents(app);
  await app.start();
  base = app.restServer.url!;

  // Author the capability contract (published on write — contract-schema kinds have no draft state).
  const put = await fetch(`${base}/v1/definitions/${DEF_ID}`, {
    method: 'PUT',
    headers: {'x-api-key': KEY_FULL, 'content-type': 'application/json'},
    body: JSON.stringify(putDefinitionReq),
  });
  expect(put.status).toBe(200);
});

afterAll(async () => {
  await app?.stop();
  if (owner) {
    await cleanupDefinitions();
    await owner.end();
  }
});

const getEffective = (k: string, tenantId: string) =>
  fetch(
    `${base}/v1/capabilities/${CAP_NAME}/provider-mapping?tenantId=${tenantId}`,
    {headers: {'x-api-key': k}},
  );

const putOverride = (k: string, tenantId: string, body: unknown) =>
  fetch(
    `${base}/v1/tenants/${tenantId}/capabilities/${CAP_NAME}/provider-mapping`,
    {
      method: 'PUT',
      headers: {'x-api-key': k, 'content-type': 'application/json'},
      body: JSON.stringify(body),
    },
  );

const deleteOverride = (k: string, tenantId: string) =>
  fetch(
    `${base}/v1/tenants/${tenantId}/capabilities/${CAP_NAME}/provider-mapping`,
    {
      method: 'DELETE',
      headers: {'x-api-key': k},
    },
  );

const overrideBody = {
  providers: [
    {providerId: 'twilio', priority: 200},
    {providerId: 'internal-default', priority: 50},
  ],
  eligibility: [],
  onNoProvider: 'handoff',
};

describe('GET/PUT/DELETE .../provider-mapping (live)', () => {
  it('GET with no override → 200 source:contract-default, the authored providerMapping', async () => {
    const res = await getEffective(KEY_FULL, TENANT);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {source: string; mapping: unknown};
    expect(body.source).toBe('contract-default');
    expect(body.mapping).toEqual(defaultMapping);
  });

  it('PUT an override (different provider ranking) → 200 source:tenant-override', async () => {
    const res = await putOverride(KEY_FULL, TENANT, overrideBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      mapping: unknown;
      updatedAt?: string;
      updatedBy?: string;
    };
    expect(body.source).toBe('tenant-override');
    expect(body.mapping).toEqual(overrideBody);
    expect(body.updatedAt).toBeTruthy();
    expect(body.updatedBy).toBeTruthy();
  });

  it('GET after PUT → the override wins over the contract default', async () => {
    const res = await getEffective(KEY_FULL, TENANT);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {source: string; mapping: unknown};
    expect(body.source).toBe('tenant-override');
    expect(body.mapping).toEqual(overrideBody);
  });

  it('DELETE → {reverted: true}; GET afterward reverts to contract-default', async () => {
    const del = await deleteOverride(KEY_FULL, TENANT);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({reverted: true});

    const res = await getEffective(KEY_FULL, TENANT);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {source: string; mapping: unknown};
    expect(body.source).toBe('contract-default');
    expect(body.mapping).toEqual(defaultMapping);
  });

  it('rejects a PUT for another tenant → 403 (tenant boundary)', async () => {
    const res = await putOverride(KEY_FULL, OTHER, overrideBody);
    expect(res.status).toBe(403);
  });

  it('rejects a principal without the required scope → 403', async () => {
    const getRes = await getEffective(KEY_NOSCOPE, TENANT);
    expect(getRes.status).toBe(403);
    const putRes = await putOverride(KEY_NOSCOPE, TENANT, overrideBody);
    expect(putRes.status).toBe(403);
  });

  it('unauthenticated → 401 (before routing)', async () => {
    const res = await fetch(
      `${base}/v1/capabilities/${CAP_NAME}/provider-mapping?tenantId=${TENANT}`,
    );
    expect(res.status).toBe(401);
  });

  it('rejects an invalid body (providers: []) → 422', async () => {
    const res = await putOverride(KEY_FULL, TENANT, {
      ...overrideBody,
      providers: [],
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as {error?: {code?: string}}).error?.code).toBe(
      'validation_failed',
    );
  });
});
