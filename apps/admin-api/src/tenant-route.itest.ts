// Live-PG integration for the TenantController (Slice 7): boots admin-api WITH Persistence and drives
// GET/PATCH /v1/tenants/{tenantId} with real api-key principals. Seeds one tenant row directly (the
// create route is a platform-operator surface, deferred) via an owner connection with the tenant GUC
// set, then proves: the tenant-scoped read (200 TenantContext), the tenant-scoped update (200 reflects
// the change), the scope gates, the tenant boundary, and validation. Needs the compose PG stack.
import 'reflect-metadata';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@platform-internal/config';
import type {PlatformRestApplication} from '@platform-internal/loopback-core';
import type {ApiKeySeed} from '@platform-internal/auth';
import type {PrincipalId, Scope, TenantId} from '@platform/contracts';
import {AdminApiRoot} from './root.js';

const TENANT = 'tnt_tenant_itest' as TenantId;
const OTHER = 'tnt_tenant_other';
const KEY_READ = 'itest-tenant-read';
const KEY_UPDATE = 'itest-tenant-update';
const KEY_NOSCOPE = 'itest-tenant-noscope';

const key = (k: string, principalId: string, scopes: Scope[]): ApiKeySeed => ({
  key: k,
  record: {keyId: `apk_${principalId}`, tenantId: TENANT, principalId: principalId as PrincipalId, scopes, status: 'active', expiresAt: null},
});

let app: PlatformRestApplication;
let base: string;
let owner: Pool;

beforeAll(async () => {
  const cfg0 = loadConfig();
  owner = new Pool({connectionString: cfg0.stores.authoritative.url, max: 2});
  // Seed the tenant row (own-tenant insert under the tenant GUC — the create route is operator-only).
  const client = await owner.connect();
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
    await client.query(`DELETE FROM tenant.tenants WHERE id = $1`, [TENANT]);
    await client.query(
      `INSERT INTO tenant.tenants (id, tenant_id, slug, display_name, status, data_residency, features)
       VALUES ($1, $1, $2, $3, 'active', 'us', '{}'::jsonb)`,
      [TENANT, 'tenant-itest-co', 'Itest Tenant'],
    );
  } finally {
    client.release();
  }

  const cfg = {...cfg0, api: {...cfg0.api, port: 0}};
  const root = new AdminApiRoot(cfg, {
    apiKeySeeds: [
      key(KEY_READ, 'prn_svc_tread', ['platform.tenant.read'] as Scope[]),
      key(KEY_UPDATE, 'prn_svc_tupd', ['platform.tenant.read', 'platform.tenant.update'] as Scope[]),
      key(KEY_NOSCOPE, 'prn_svc_tnos', ['tenant.role.read'] as Scope[]),
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
    const client = await owner.connect();
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
      await client.query(`DELETE FROM tenant.tenants WHERE id = $1`, [TENANT]);
    } finally {
      client.release();
    }
    await owner.end();
  }
});

describe('GET/PATCH /v1/tenants/{tenantId} (live)', () => {
  it('reads the caller’s own tenant → 200 TenantContext', async () => {
    const res = await fetch(`${base}/v1/tenants/${TENANT}`, {headers: {'x-api-key': KEY_READ}});
    expect(res.status).toBe(200);
    const ctx = (await res.json()) as {tenantId: string; slug: string; displayName: string; status: string};
    expect(ctx).toMatchObject({tenantId: TENANT, slug: 'tenant-itest-co', displayName: 'Itest Tenant', status: 'active'});
  });

  it('updates the caller’s own tenant → 200 reflecting the change', async () => {
    const res = await fetch(`${base}/v1/tenants/${TENANT}`, {
      method: 'PATCH',
      headers: {'x-api-key': KEY_UPDATE, 'content-type': 'application/json'},
      body: JSON.stringify({displayName: 'Renamed Tenant', features: {beta: true}}),
    });
    expect(res.status).toBe(200);
    const ctx = (await res.json()) as {displayName: string; features: Record<string, boolean>};
    expect(ctx.displayName).toBe('Renamed Tenant');
    expect(ctx.features).toEqual({beta: true});
  });

  it('rejects an invalid patch body → 422', async () => {
    const res = await fetch(`${base}/v1/tenants/${TENANT}`, {
      method: 'PATCH',
      headers: {'x-api-key': KEY_UPDATE, 'content-type': 'application/json'},
      body: JSON.stringify({status: 'not-a-status'}),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as {error?: {code?: string}}).error?.code).toBe('validation_failed');
  });

  it('rejects a principal without platform.tenant.read → 403', async () => {
    const res = await fetch(`${base}/v1/tenants/${TENANT}`, {headers: {'x-api-key': KEY_NOSCOPE}});
    expect(res.status).toBe(403);
  });

  it('rejects reading/updating another tenant → 403 (tenant boundary)', async () => {
    const read = await fetch(`${base}/v1/tenants/${OTHER}`, {headers: {'x-api-key': KEY_READ}});
    expect(read.status).toBe(403);
    const upd = await fetch(`${base}/v1/tenants/${OTHER}`, {
      method: 'PATCH',
      headers: {'x-api-key': KEY_UPDATE, 'content-type': 'application/json'},
      body: JSON.stringify({displayName: 'x'}),
    });
    expect(upd.status).toBe(403);
  });

  it('unauthenticated → 401 (before routing)', async () => {
    const res = await fetch(`${base}/v1/tenants/${TENANT}`);
    expect(res.status).toBe(401);
  });
});
