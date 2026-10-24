// CT1 itest (live PG): tenant.tenants now keys on the TEXT `tnt_…` brand (migration 0028, decided
// 2026-07-14). Proves the fail-closed defect is FIXED — a text-GUC session SEES its tenant row (it
// previously saw zero rows against the uuid column) — plus cross-tenant isolation and the brand-shape
// backstop CHECK.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@hermes-one/config';
import {runMigrations} from './migrate.js';
import {createPlatformDb, type PlatformDbHandle} from './client.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const A = 'tnt_ct1_a';
const B = 'tnt_ct1_b';

let owner: Pool;
let app: PlatformDbHandle;

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

const wipe = async () => {
  await owner.query(`DELETE FROM tenant.tenants WHERE tenant_id IN ($1,$2)`, [
    A,
    B,
  ]);
};

beforeAll(async () => {
  await runMigrations(PG);
  owner = new Pool({connectionString: PG, max: 2});
  app = createPlatformDb(PG);
  await wipe();
  await owner.query(
    `INSERT INTO tenant.tenants (id, tenant_id, slug, display_name, status, data_residency)
     VALUES ($1, $1, 'ct1-a', 'CT1 A', 'active', 'us'), ($2, $2, 'ct1-b', 'CT1 B', 'active', 'us')`,
    [A, B],
  );
});

afterAll(async () => {
  await wipe();
  await owner.end();
  await app.close();
});

describe('tenant.tenants text-brand ids (CT1, migration 0028)', () => {
  it('a text-GUC session SEES its own tenant row (the pre-CT1 fail-closed defect is fixed)', async () => {
    const rows = await asTenant<{id: string; slug: string}>(
      A,
      `SELECT id, slug FROM tenant.tenants`,
    );
    expect(rows).toEqual([{id: A, slug: 'ct1-a'}]);
  });

  it('cross-tenant rows stay invisible (strict RLS, plain text compare)', async () => {
    const rows = await asTenant<{id: string}>(
      B,
      `SELECT id FROM tenant.tenants`,
    );
    expect(rows).toEqual([{id: B}]);
  });

  it('the brand-shape backstop rejects a raw uuid id', async () => {
    await expect(
      owner.query(
        `INSERT INTO tenant.tenants (id, tenant_id, slug, display_name, status, data_residency)
         VALUES ('a2f6b4de-0000-4000-8000-000000000000', $1, 'ct1-bad', 'Bad', 'active', 'us')`,
        [A],
      ),
    ).rejects.toThrow(/tenants_id_brand_ck/);
  });
});
