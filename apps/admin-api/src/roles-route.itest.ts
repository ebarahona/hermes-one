// Live-PG integration for the first datasource-backed admin route (Slice 3): boots the real
// admin-api WITH Persistence (shared pool + RLS boot gate) on an ephemeral port and drives
// GET /v1/tenants/{tenantId}/roles over HTTP with real api-key principals. Proves: scope gate
// (tenant.role.read → 200 / missing → 403), tenant boundary (another tenant's path → 403), and that
// the read is tenant-scoped through the RLS-enforced DrizzleRoleRegistry (a seeded tenant role shows
// up alongside the platform roles). Needs the compose PG stack (like the other itests).
import 'reflect-metadata';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {loadConfig} from '@platform-internal/config';
import {
  PlatformBindings,
  type PlatformRestApplication,
} from '@platform-internal/loopback-core';
import type {ApiKeySeed} from '@platform-internal/auth';
import type {
  PrincipalId,
  RoleDefinition,
  RoleId,
  RoleRegistry,
  Scope,
  TenantId,
} from '@platform/contracts';
import {AdminApiRoot} from './root.js';

/** The bound registry is a DrizzleRoleRegistry — its tenant-scoped `deleteFor` (impl-only, used for
 *  idempotent test cleanup) is not on the RoleRegistry port. */
interface RoleAdmin extends RoleRegistry {
  deleteFor(tenantId: TenantId, roleId: RoleId): Promise<void>;
}

const TENANT = 'tnt_roles_itest' as TenantId;
const OTHER = 'tnt_roles_other' as TenantId;
const KEY_READ = 'itest-key-read';
const KEY_NOSCOPE = 'itest-key-noscope';
const KEY_WRITE = 'itest-key-write';
const SEED_ROLE = 'dispatcher';
const CREATED_ROLE = 'apicreated';

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
let seededRoleId: RoleId;

beforeAll(async () => {
  const loaded = loadConfig();
  const cfg = {...loaded, api: {...loaded.api, port: 0}};
  const root = new AdminApiRoot(cfg, {
    apiKeySeeds: [
      key(KEY_READ, 'prn_svc_reader', ['tenant.role.read'] as Scope[]),
      key(KEY_NOSCOPE, 'prn_svc_noscope', ['tenant.user.read'] as Scope[]), // a scope, but NOT role.read
      key(KEY_WRITE, 'prn_svc_writer', [
        'tenant.role.read',
        'tenant.role.create',
      ] as Scope[]),
    ],
  });
  app = root.createApp();
  root.bindPorts(app);
  root.registerComponents(app);
  await app.start(); // RLS boot gate runs here
  base = app.restServer.url!;

  // Seed a tenant-scoped role through the RLS-enforced registry (idempotent across re-runs).
  const registry = await app.get<RoleAdmin>(PlatformBindings.ROLE_REGISTRY.key);
  seededRoleId =
    `rol_${TENANT.replace(/[^a-z0-9]/gi, '')}_${SEED_ROLE}` as RoleId;
  await registry.deleteFor(TENANT, seededRoleId).catch(() => void 0);
  await registry
    .deleteFor(
      TENANT,
      `rol_${TENANT.replace(/[^a-z0-9]/gi, '')}_${CREATED_ROLE}` as RoleId,
    )
    .catch(() => void 0);
  const created: RoleDefinition = await registry.create({
    tenantId: TENANT,
    name: SEED_ROLE,
    scopes: ['tenant.role.read'] as Scope[],
    description: 'itest seed',
  });
  seededRoleId = created.roleId;
});

afterAll(async () => {
  if (app) {
    const registry = await app.get<RoleAdmin>(
      PlatformBindings.ROLE_REGISTRY.key,
    );
    await registry.deleteFor(TENANT, seededRoleId).catch(() => void 0);
    await registry
      .deleteFor(
        TENANT,
        `rol_${TENANT.replace(/[^a-z0-9]/gi, '')}_${CREATED_ROLE}` as RoleId,
      )
      .catch(() => void 0);
    await app.stop();
  }
});

describe('GET /v1/tenants/{tenantId}/roles (live)', () => {
  it('returns the tenant’s roles (seeded + platform) for a scoped principal', async () => {
    const res = await fetch(`${base}/v1/tenants/${TENANT}/roles`, {
      headers: {'x-api-key': KEY_READ},
    });
    expect(res.status).toBe(200);
    const roles = (await res.json()) as Array<{
      name: string;
      roleId: string;
      scopes: string[];
    }>;
    expect(roles.some(r => r.name === SEED_ROLE)).toBe(true); // the tenant-scoped seed
    expect(roles.some(r => r.name === 'customer')).toBe(true); // a platform role (migration 0029)
  });

  it('rejects a principal without tenant.role.read → 403 forbidden_scope', async () => {
    const res = await fetch(`${base}/v1/tenants/${TENANT}/roles`, {
      headers: {'x-api-key': KEY_NOSCOPE},
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as {error?: {code?: string}}).error?.code).toBe(
      'forbidden_scope',
    );
  });

  it('rejects reading another tenant’s roles → 403 (tenant boundary, never the path’s tenant)', async () => {
    const res = await fetch(`${base}/v1/tenants/${OTHER}/roles`, {
      headers: {'x-api-key': KEY_READ},
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as {error?: {code?: string}}).error?.code).toBe(
      'forbidden_scope',
    );
  });

  it('rejects an unauthenticated read → 401 (before routing)', async () => {
    const res = await fetch(`${base}/v1/tenants/${TENANT}/roles`);
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/tenants/{tenantId}/roles (live)', () => {
  const post = (key: string, body: unknown, tenant: string = TENANT) =>
    fetch(`${base}/v1/tenants/${tenant}/roles`, {
      method: 'POST',
      headers: {'x-api-key': key, 'content-type': 'application/json'},
      body: JSON.stringify(body),
    });

  it('creates a tenant role (201) that then appears in the list', async () => {
    const res = await post(KEY_WRITE, {
      name: CREATED_ROLE,
      scopes: ['tenant.role.read'],
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      roleId: string;
      name: string;
      scopes: string[];
    };
    expect(created.name).toBe(CREATED_ROLE);
    expect(created.roleId).toMatch(/^rol_/);

    const list = (await (
      await fetch(`${base}/v1/tenants/${TENANT}/roles`, {
        headers: {'x-api-key': KEY_WRITE},
      })
    ).json()) as Array<{name: string}>;
    expect(list.some(r => r.name === CREATED_ROLE)).toBe(true);
  });

  it('rejects a duplicate role name → 409 conflict', async () => {
    const res = await post(KEY_WRITE, {name: CREATED_ROLE, scopes: []});
    expect(res.status).toBe(409);
  });

  it('rejects an invalid body → 422 validation_failed', async () => {
    const res = await post(KEY_WRITE, {scopes: ['x.y.z']}); // missing name
    expect(res.status).toBe(422);
    expect(((await res.json()) as {error?: {code?: string}}).error?.code).toBe(
      'validation_failed',
    );
  });

  it('rejects a principal without tenant.role.create → 403', async () => {
    const res = await post(KEY_READ, {name: 'nope', scopes: []}); // read-only key
    expect(res.status).toBe(403);
  });

  it('rejects creating in another tenant → 403 (tenant boundary)', async () => {
    const res = await post(KEY_WRITE, {name: 'nope', scopes: []}, OTHER);
    expect(res.status).toBe(403);
  });
});
