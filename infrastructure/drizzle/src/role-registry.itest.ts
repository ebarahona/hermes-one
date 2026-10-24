// Live-PG itest for DrizzleRoleRegistry (AUTH-2): platform-default
// resolution, tenant shadowing, per-request freshness (never cached), unknown-role → no scopes,
// and the seeded platform matrix from migration 0029.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@hermes-one/config';
import type {RoleId, TenantId} from '@hermes-one/contracts';
import {runMigrations} from './migrate.js';
import {createRoleRegistry, type RoleRegistryHandle} from './client.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const T = 'tnt_roles_itest' as TenantId;

let owner: Pool;
let sut: RoleRegistryHandle;

const wipe = async () => {
  await owner.query(`DELETE FROM tenant.roles WHERE tenant_id = $1`, [T]);
};

beforeAll(async () => {
  await runMigrations(PG);
  owner = new Pool({connectionString: PG, max: 2});
  sut = createRoleRegistry(PG);
  await wipe();
});

afterAll(async () => {
  await wipe();
  await owner.end();
  await sut.close();
});

describe('DrizzleRoleRegistry (live)', () => {
  it('resolves the seeded platform customer role (migration 0029)', async () => {
    const scopes = await sut.repo.resolveScopes(T, ['customer']);
    expect(scopes).toContain('appointment.slot.read');
    expect(scopes).toContain('appointment.booking.create');
  });

  it('a tenant row SHADOWS the platform row of the same name', async () => {
    await sut.repo.create({
      tenantId: T,
      name: 'customer',
      scopes: [
        'appointment.slot.read',
        'appointment.booking.create',
        'appointment.booking.cancel',
      ] as never,
      description: 'tenant lets customers self-cancel',
    });
    const scopes = await sut.repo.resolveScopes(T, ['customer']);
    expect(scopes).toContain('appointment.booking.cancel'); // tenant addition
    const viaGet = await sut.repo.get(T, 'customer');
    expect(viaGet?.tenantId).toBe(T); // the tenant row won, not the platform NULL row
  });

  it('resolution is NEVER cached — a role edit takes effect on the next request', async () => {
    const role = await sut.repo.get(T, 'customer');
    await sut.repo.updateFor(T, role!.roleId as RoleId, {
      scopes: ['appointment.slot.read'] as never, // drop the cancel/create scopes
    });
    const scopes = await sut.repo.resolveScopes(T, ['customer']);
    expect(scopes).toEqual(['appointment.slot.read']);
  });

  it('unknown roles resolve to no scopes; unions dedupe across roles', async () => {
    expect(await sut.repo.resolveScopes(T, ['nope'])).toEqual([]);
    const union = await sut.repo.resolveScopes(T, [
      'customer',
      'inbound-source',
    ]);
    expect(union).toContain('appointment.slot.read'); // tenant customer (post-edit)
    expect(union).toContain('channel.inbound.ingest'); // platform inbound-source
    expect(new Set(union).size).toBe(union.length); // deduped
  });

  it('list() unions platform + tenant rows with shadowing applied', async () => {
    const all = await sut.repo.list(T);
    const customer = all.find(r => r.name === 'customer');
    expect(customer?.tenantId).toBe(T); // shadowed
    expect(
      all.some(r => r.name === 'inbound-source' && r.tenantId === null),
    ).toBe(true);
  });
});
