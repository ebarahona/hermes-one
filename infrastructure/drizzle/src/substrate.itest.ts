// Integration test against the live backing stack (Postgres :5433, Redis :6380). Proves the Phase-2
// data layer end to end: migrations apply, platform_app is non-bypassing, content-hash dedupe,
// Redis cache-through with mandatory hash verification, deployment reconstruction, and RLS isolation.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@hermes-one/config';
import {createRedisClient, type RedisClient} from '@hermes-one/redis';
import type {
  CompiledPlanBase,
  ContentHash,
  DefinitionId,
  PlanId,
  SemVer,
  IsoTimestamp,
  TenantId,
} from '@hermes-one/contracts';
import {runMigrations} from './migrate.js';
import {
  createPlatformDb,
  createCompiledPlanStore,
  type CompiledPlanStoreHandle,
  type PlatformDbHandle,
} from './client.js';
import {assertNonBypassingRole} from './rls-self-check.js';
import {SubstrateCacheKeys} from './adapters/compiled-plan-store.repository.js';

const H = (seed: string): ContentHash =>
  `sha256:${seed.repeat(64).slice(0, 64)}` as ContentHash;
const TENANT_A = 'tnt_a' as TenantId;
const TENANT_B = 'tnt_b' as TenantId;
const DEF = 'def_it' as DefinitionId;
const PLN = 'pln_it' as PlanId;
const PLAN_HASH = H('a');

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const REDIS = cfg.stores.ephemeral.url;

let owner: Pool; // superuser (hermes) — seeds test data, bypassing RLS
let redis: RedisClient; // raw redis for cache manipulation
let app: PlatformDbHandle; // request-time handle (SET ROLE platform_app)
let sut: CompiledPlanStoreHandle; // system under test

const plan: CompiledPlanBase = {
  planId: PLN,
  definitionId: DEF,
  kind: 'workflow',
  version: '1.0.0' as SemVer,
  contentHash: PLAN_HASH,
  compilerVersion: '1.0.0' as SemVer,
  compiledAt: '2026-07-11T00:00:00.000Z' as IsoTimestamp,
};

beforeAll(async () => {
  await runMigrations(PG);
  owner = new Pool({connectionString: PG, max: 2});
  redis = createRedisClient(REDIS);
  app = createPlatformDb(PG);
  sut = createCompiledPlanStore(PG, REDIS);

  // Clean any residue from a prior run, then seed the FK/deployment fixtures as the superuser owner.
  await owner.query(
    `DELETE FROM substrate.deployment_members WHERE deployment_id IN ('dpl_a', 'dpl_a2')`,
  );
  await owner.query(
    `DELETE FROM substrate.deployments WHERE deployment_id IN ('dpl_a', 'dpl_a2')`,
  );
  await owner.query(
    `DELETE FROM substrate.compiled_plans WHERE content_hash = $1`,
    [PLAN_HASH],
  );
  await owner.query(
    `DELETE FROM substrate.definitions WHERE definition_id IN ('def_it','def_eng','def_pol')`,
  );
  await redis.del(SubstrateCacheKeys.plan(TENANT_A, PLN, PLAN_HASH));
  await redis.del(SubstrateCacheKeys.activeDeployment(TENANT_A));
  await redis.del(SubstrateCacheKeys.activeDeployment(TENANT_B));

  for (const [id, name] of [
    ['def_it', 'intake'],
    ['def_eng', 'engine'],
    ['def_pol', 'policy'],
  ] as const) {
    await owner.query(
      `INSERT INTO substrate.definitions (definition_id, tenant_id, kind, name, schema_ref, current_version, status, created_by)
       VALUES ($1, 'tnt_a', 'workflow', $2, $3, '1.0.0', 'published', 'prn_seed')`,
      [id, name, `${name}.workflow/v1`],
    );
  }
  await owner.query(
    `INSERT INTO substrate.deployments (deployment_id, tenant_id, version, status, operator_registry_version, created_by)
     VALUES ('dpl_a', 'tnt_a', '1.0.0', 'active', '1.0.0', 'prn_seed')`,
  );
  const members: Array<[string, number, string, string | null, string]> = [
    ['workflow', 0, 'def_it', 'pln_it', H('a')],
    ['agent-engine', 0, 'def_eng', null, H('b')],
    ['policy', 0, 'def_pol', 'pln_pol', H('c')],
  ];
  for (const [kind, seq, defId, planId, ch] of members) {
    await owner.query(
      `INSERT INTO substrate.deployment_members (deployment_id, kind, seq, definition_id, plan_id, version, content_hash)
       VALUES ('dpl_a', $1, $2, $3, $4, '1.0.0', $5)`,
      [kind, seq, defId, planId, ch],
    );
  }
});

afterAll(async () => {
  await sut?.close();
  await app?.close();
  await redis?.close();
  await owner?.end();
});

describe('platform_app role posture (RLS precondition)', () => {
  it('is NOSUPERUSER and NOBYPASSRLS', async () => {
    const posture = await assertNonBypassingRole(app.db);
    expect(posture.role).toBe('platform_app');
    expect(posture.isSuperuser).toBe(false);
    expect(posture.bypassRls).toBe(false);
  });
});

describe('content-hash dedupe (ON CONFLICT DO NOTHING)', () => {
  it('inserts once, then dedupes; exactly one row per contentHash', async () => {
    const first = await sut.store.putCompiledPlan(
      plan,
      JSON.stringify(plan).length,
    );
    const second = await sut.store.putCompiledPlan(
      plan,
      JSON.stringify(plan).length,
    );
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(first.planId).toBe(PLN);
    const {rows} = await owner.query(
      `SELECT count(*)::int AS n FROM substrate.compiled_plans WHERE content_hash = $1`,
      [PLAN_HASH],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('Redis cache-through + mandatory contentHash verify', () => {
  it('rebuilds from Postgres on a cold key, then serves warm; corruption throws', async () => {
    const key = SubstrateCacheKeys.plan(TENANT_A, PLN, PLAN_HASH);
    await redis.del(key);
    const cold = await sut.store.resolvePlanCached(TENANT_A, PLN, PLAN_HASH);
    expect(cold.contentHash).toBe(PLAN_HASH);
    expect(await redis.get(key)).not.toBeNull(); // SETEX populated the cache

    const warm = await sut.store.resolvePlanCached(TENANT_A, PLN, PLAN_HASH);
    expect(warm.planId).toBe(PLN);

    // Hand-corrupt the cached value to a different hash — a mismatch must throw, never return.
    await redis.setex(key, 60, JSON.stringify({...plan, contentHash: H('f')}));
    await expect(
      sut.store.resolvePlanCached(TENANT_A, PLN, PLAN_HASH),
    ).rejects.toThrow();
  });
});

describe('deployment reconstruction + RLS isolation', () => {
  it('reconstructs tenant A active deployment; tenant B cannot see it', async () => {
    const dep = await sut.store.resolveActiveDeploymentCached(TENANT_A);
    expect(dep.deploymentId).toBe('dpl_a');
    expect(dep.tenantId).toBe(TENANT_A);
    expect(dep.workflow.definitionId).toBe('def_it');
    expect(dep.agentEngine.planId).toBeNull();
    expect(dep.policy.definitionId).toBe('def_pol');
    expect(dep.rules).toEqual([]);

    // Tenant B has no active deployment; RLS also hides A's row → hard not_found, never A's data.
    await expect(
      sut.store.resolveActiveDeploymentCached(TENANT_B),
    ).rejects.toThrow();
  });
});

describe('resolve-by-pinned-ref (D1 — replay determinism across supersede)', () => {
  it('a pinned deployment resolves unchanged after a newer version supersedes it', async () => {
    // Supersede v1.0.0 THEN publish v1.0.1 — the same order DeploymentService.publish uses (the
    // deployments_tenant_active_uq partial-unique enforces one active per tenant).
    await owner.query(
      `UPDATE substrate.deployments SET status = 'superseded' WHERE deployment_id = 'dpl_a'`,
    );
    await owner.query(
      `INSERT INTO substrate.deployments (deployment_id, tenant_id, version, status, operator_registry_version, created_by)
       VALUES ('dpl_a2', 'tnt_a', '1.0.1', 'active', '1.0.0', 'prn_seed')
       ON CONFLICT (deployment_id) DO NOTHING`,
    );
    for (const [kind, defId, planId, ch] of [
      ['workflow', 'def_it', 'pln_it', H('a')],
      ['agent-engine', 'def_eng', null, H('d')],
      ['policy', 'def_pol', 'pln_pol', H('c')],
    ] as const) {
      await owner.query(
        `INSERT INTO substrate.deployment_members (deployment_id, kind, seq, definition_id, plan_id, version, content_hash)
         VALUES ('dpl_a2', $1, 0, $2, $3, '1.0.1', $4) ON CONFLICT DO NOTHING`,
        [kind, defId, planId, ch],
      );
    }

    // The pin still resolves the EXACT superseded manifest — engine hash is v1's H('b'), not v2's H('d').
    const pinned = await sut.store.resolveDeployment(TENANT_A, 'dpl_a');
    expect(pinned.deploymentId).toBe('dpl_a');
    expect(pinned.status).toBe('superseded');
    expect(pinned.version).toBe('1.0.0');
    expect(pinned.agentEngine.contentHash).toBe(H('b'));

    // Resolve-by-version (DeploymentService.resolveVersion) finds the historical row.
    const v1 = await sut.store.resolveDeploymentByVersion(TENANT_A, '1.0.0');
    expect(v1.deploymentId).toBe('dpl_a');
    expect(v1.agentEngine.contentHash).toBe(H('b'));

    // RLS: tenant B cannot resolve tenant A's pin — fail-closed not_found, never A's data.
    await expect(
      sut.store.resolveDeployment(TENANT_B, 'dpl_a'),
    ).rejects.toThrow(/not found/);
    await expect(
      sut.store.resolveDeploymentByVersion(TENANT_B, '1.0.0'),
    ).rejects.toThrow(/no deployment/);

    // Restore v1 active so this file stays idempotent across re-runs (supersede first — one active).
    await owner.query(
      `UPDATE substrate.deployments SET status = 'superseded' WHERE deployment_id = 'dpl_a2'`,
    );
    await owner.query(
      `UPDATE substrate.deployments SET status = 'active' WHERE deployment_id = 'dpl_a'`,
    );
  });
});
