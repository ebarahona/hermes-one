// Integration test against the live backing stack (Postgres :5433). Proves the remaining 21-table catalog
// (migrations 0019–0027) is real and correctly isolated: the tenant/capability/event tables enforce RLS
// (strict + nullable-tenant), the substrate reconciliation views apply base-table RLS via
// security_invoker (no cross-tenant leak through a view), and a representative partial-unique holds.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@hermes-one/config';
import {runMigrations} from './migrate.js';
import {createPlatformDb, type PlatformDbHandle} from './client.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const A = 'tnt_cat_a';
const B = 'tnt_cat_b';

let owner: Pool; // superuser — seeds across tenants, bypassing RLS
let app: PlatformDbHandle; // platform_app (NOBYPASSRLS) — the real request-time role

/** Run a read as platform_app with app.tenant_id pinned to `tenant` (session-scoped on one client). */
async function asTenant<T>(tenant: string, q: string): Promise<T[]> {
  const client = await app.pool.connect();
  try {
    await client.query(`select set_config('app.tenant_id', $1, false)`, [
      tenant,
    ]);
    const r = await client.query(q);
    return r.rows as T[];
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await runMigrations(PG);
  owner = new Pool({connectionString: PG, max: 3});
  app = createPlatformDb(PG);

  // Clean prior residue.
  await owner.query(`DELETE FROM tenant.users WHERE tenant_id IN ($1,$2)`, [
    A,
    B,
  ]);
  await owner.query(
    `DELETE FROM tenant.roles WHERE tenant_id = $1 OR (tenant_id IS NULL AND name = 'cat_platform_role')`,
    [A],
  );
  await owner.query(
    `DELETE FROM event.event_outbox WHERE tenant_id IN ($1,$2)`,
    [A, B],
  );
  await owner.query(
    `DELETE FROM substrate.definitions WHERE definition_id IN ('def_cat_wf')`,
  );

  // Seed (owner bypasses RLS).
  await owner.query(
    `INSERT INTO tenant.users (principal_id, tenant_id, kind) VALUES ('prn_cat_a','${A}','user'),('prn_cat_b','${B}','user')`,
  );
  await owner.query(
    `INSERT INTO tenant.roles (role_id, tenant_id, name, scopes) VALUES ('rol_cat_a','${A}','cat_tenant_role','{}'), ('rol_cat_plat', NULL, 'cat_platform_role','{}')`,
  );
  await owner.query(
    `INSERT INTO event.event_outbox (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload) VALUES ('obx_a','${A}','audit_event','aud_1','x','{}'), ('obx_b','${B}','audit_event','aud_2','x','{}')`,
  );
  await owner.query(
    `INSERT INTO substrate.definitions (definition_id, tenant_id, kind, name, schema_ref, current_version, status, created_by)
     VALUES ('def_cat_wf','${A}','workflow','cat-wf','cat-wf.workflow/v1','1.0.0','published','prn_seed')`,
  );
});

afterAll(async () => {
  await owner.query(`DELETE FROM tenant.users WHERE tenant_id IN ($1,$2)`, [
    A,
    B,
  ]);
  await owner.query(
    `DELETE FROM tenant.roles WHERE tenant_id = $1 OR (tenant_id IS NULL AND name = 'cat_platform_role')`,
    [A],
  );
  await owner.query(
    `DELETE FROM event.event_outbox WHERE tenant_id IN ($1,$2)`,
    [A, B],
  );
  await owner.query(
    `DELETE FROM substrate.definitions WHERE definition_id = 'def_cat_wf'`,
  );
  await owner.end();
  await app.close();
});

describe('remaining catalog (tenant / capability / event / views) — live', () => {
  it('tenant.users enforces strict RLS isolation', async () => {
    const rows = await asTenant<{principal_id: string}>(
      A,
      `SELECT principal_id FROM tenant.users`,
    );
    expect(rows.map(r => r.principal_id)).toEqual(['prn_cat_a']); // B is invisible
  });

  it('tenant.roles is nullable-tenant — platform (NULL) roles visible to every tenant', async () => {
    // Scoped to this test's fixtures (migration 0029 seeds additional platform roles).
    const forA = await asTenant<{name: string}>(
      A,
      `SELECT name FROM tenant.roles WHERE name LIKE 'cat\\_%' ORDER BY name`,
    );
    expect(forA.map(r => r.name)).toEqual([
      'cat_platform_role',
      'cat_tenant_role',
    ]); // own + platform
    const forB = await asTenant<{name: string}>(
      B,
      `SELECT name FROM tenant.roles WHERE name LIKE 'cat\\_%' ORDER BY name`,
    );
    expect(forB.map(r => r.name)).toEqual(['cat_platform_role']); // only platform (A's role hidden)
  });

  it('event.event_outbox enforces strict RLS isolation', async () => {
    const rows = await asTenant<{outbox_id: string}>(
      A,
      `SELECT outbox_id FROM event.event_outbox WHERE outbox_id IN ('obx_a','obx_b')`,
    );
    expect(rows.map(r => r.outbox_id)).toEqual(['obx_a']);
  });

  it('substrate reconciliation views apply base-table RLS (security_invoker — no cross-tenant leak)', async () => {
    const seenByA = await asTenant<{definition_id: string}>(
      A,
      `SELECT definition_id FROM substrate.workflow_definitions WHERE definition_id = 'def_cat_wf'`,
    );
    expect(seenByA.map(r => r.definition_id)).toEqual(['def_cat_wf']);
    const seenByB = await asTenant<{definition_id: string}>(
      B,
      `SELECT definition_id FROM substrate.workflow_definitions WHERE definition_id = 'def_cat_wf'`,
    );
    expect(seenByB).toHaveLength(0); // the view did NOT bypass RLS
  });

  it('roles platform partial-unique rejects a duplicate platform role name', async () => {
    await expect(
      owner.query(
        `INSERT INTO tenant.roles (role_id, tenant_id, name, scopes) VALUES ('rol_cat_dup', NULL, 'cat_platform_role','{}')`,
      ),
    ).rejects.toThrow(/roles_platform_name_uq|duplicate key/);
  });
});
