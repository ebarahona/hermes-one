// Live-PG integration for the UserController (Slice 10): boots admin-api WITH Persistence and drives
// POST/GET /v1/tenants/{tenantId}/users with real api-key principals. Proves the tenant-scoped
// create (201 UserDto → appears in the list), the per-tenant uniqueness conflict (409), validation,
// the scope gates, and the tenant boundary — all through the RLS-enforced DrizzleUserRepository.
// Needs the compose PG stack.
import 'reflect-metadata';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@hermes-one/config';
import type {PlatformRestApplication} from '@hermes-one/loopback-core';
import type {ApiKeySeed} from '@hermes-one/auth';
import type {PrincipalId, Scope, TenantId} from '@hermes-one/contracts';
import {AdminApiRoot} from './root.js';

const TENANT = 'tnt_user_itest' as TenantId;
const OTHER = 'tnt_user_other';
const KEY_WRITE = 'itest-user-write';
const KEY_NOSCOPE = 'itest-user-noscope';

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

let app: PlatformRestApplication;
let base: string;
let owner: Pool;

async function cleanup(): Promise<void> {
  const c = await owner.connect();
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
    await c.query(`DELETE FROM tenant.users WHERE tenant_id = $1`, [TENANT]);
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  const loaded = loadConfig();
  owner = new Pool({connectionString: loaded.stores.authoritative.url, max: 2});
  await cleanup();

  const cfg = {...loaded, api: {...loaded.api, port: 0}};
  const root = new AdminApiRoot(cfg, {
    apiKeySeeds: [
      key(KEY_WRITE, 'prn_svc_uwrite', [
        'tenant.user.create',
        'tenant.user.read',
      ] as Scope[]),
      key(KEY_NOSCOPE, 'prn_svc_unos', ['tenant.role.read'] as Scope[]),
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

const create = (key: string, body: unknown, tenant: string = TENANT) =>
  fetch(`${base}/v1/tenants/${tenant}/users`, {
    method: 'POST',
    headers: {'x-api-key': key, 'content-type': 'application/json'},
    body: JSON.stringify(body),
  });

describe('POST/GET /v1/tenants/{tenantId}/users (live)', () => {
  it('creates a service user (201) that then appears in the list', async () => {
    const res = await create(KEY_WRITE, {
      kind: 'service',
      displayName: 'Dispatcher Bot',
      roleNames: ['customer'],
      externalHandle: 'dispatcher-bot',
    });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as {
      principalId: string;
      kind: string;
      roleNames: string[];
      status: string;
    };
    expect(dto.principalId).toMatch(/^prn_/);
    expect(dto.kind).toBe('service');
    expect(dto.roleNames).toEqual(['customer']);
    expect(dto.status).toBe('active');

    const list = (await (
      await fetch(`${base}/v1/tenants/${TENANT}/users`, {
        headers: {'x-api-key': KEY_WRITE},
      })
    ).json()) as {items: Array<{principalId: string}>; hasMore: boolean};
    expect(list.items.some(u => u.principalId === dto.principalId)).toBe(true);
    expect(list.hasMore).toBe(false);
  });

  it('rejects a duplicate externalHandle → 409 conflict', async () => {
    const res = await create(KEY_WRITE, {
      kind: 'service',
      externalHandle: 'dispatcher-bot',
    }); // same handle
    expect(res.status).toBe(409);
  });

  it('rejects an invalid body → 422', async () => {
    const res = await create(KEY_WRITE, {displayName: 'no kind'}); // missing kind
    expect(res.status).toBe(422);
    expect(((await res.json()) as {error?: {code?: string}}).error?.code).toBe(
      'validation_failed',
    );
  });

  it('rejects a principal without tenant.user.create → 403', async () => {
    expect((await create(KEY_NOSCOPE, {kind: 'user'})).status).toBe(403);
  });

  it('rejects creating in another tenant → 403 (tenant boundary)', async () => {
    expect((await create(KEY_WRITE, {kind: 'user'}, OTHER)).status).toBe(403);
  });

  it('unauthenticated → 401 (before routing)', async () => {
    expect(
      (
        await fetch(`${base}/v1/tenants/${TENANT}/users`, {
          headers: {'x-api-key': KEY_NOSCOPE},
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`${base}/v1/tenants/${TENANT}/users`)).status).toBe(
      401,
    );
  });
});
