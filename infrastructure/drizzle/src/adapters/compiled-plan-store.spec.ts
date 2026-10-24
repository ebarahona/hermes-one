// Unit tests for the cache-key grammar and the mandatory contentHash verification on a cache hit.
// No database: the cache-hit path never touches Postgres, so a stub db is sufficient.
import {describe, expect, it} from 'vitest';
import type {
  CompiledPlanBase,
  ContentHash,
  DefinitionId,
  PlanId,
  SemVer,
  IsoTimestamp,
  TenantId,
} from '@hermes-one/contracts';
import {PlatformErrorException} from '@hermes-one/contracts';
import type {RedisClient} from '@hermes-one/redis';
import type {PlatformDb} from '../tenant-aware.repository.js';
import {
  DrizzleCompiledPlanStore,
  SubstrateCacheKeys,
} from './compiled-plan-store.repository.js';

const hash = (c: string): ContentHash =>
  `sha256:${c.repeat(64).slice(0, 64)}` as ContentHash;

function fakeRedis(seed: Record<string, string> = {}): RedisClient {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get: async k => map.get(k) ?? null,
    setex: async (k, _ttl, v) => void map.set(k, v),
    del: async k => void map.delete(k),
    publish: async () => {},
    setnx: async () => true,
    subscribe: async () => async () => {},
    close: async () => {},
  };
}

const planFor = (contentHash: ContentHash): CompiledPlanBase => ({
  planId: 'pln_x' as PlanId,
  definitionId: 'def_x' as DefinitionId,
  kind: 'workflow',
  version: '1.0.0' as SemVer,
  contentHash,
  compilerVersion: '1.0.0' as SemVer,
  compiledAt: '2026-07-11T00:00:00.000Z' as IsoTimestamp,
});

const stubDb = {} as PlatformDb;
const tnt = 'tnt_acme' as TenantId;
const pln = 'pln_x' as PlanId;

describe('SubstrateCacheKeys', () => {
  it('builds tenant-scoped, contentHash-embedded keys', () => {
    const ch = hash('a');
    expect(SubstrateCacheKeys.plan(tnt, pln, ch)).toBe(
      `plan:tnt_acme:pln_x:${ch}`,
    );
    expect(SubstrateCacheKeys.contract(tnt, 'def_x' as DefinitionId, ch)).toBe(
      `contract:tnt_acme:def_x:${ch}`,
    );
    expect(SubstrateCacheKeys.activeDeployment(tnt)).toBe(
      'deployment:tnt_acme:active',
    );
  });
});

describe('resolvePlanCached — mandatory contentHash verify', () => {
  it('returns the cached plan when the hash matches', async () => {
    const ch = hash('b');
    const redis = fakeRedis({
      [SubstrateCacheKeys.plan(tnt, pln, ch)]: JSON.stringify(planFor(ch)),
    });
    const store = new DrizzleCompiledPlanStore(stubDb, redis);
    const plan = await store.resolvePlanCached(tnt, pln, ch);
    expect(plan.contentHash).toBe(ch);
  });

  it('throws (never returns) when a cached entry has been corrupted to a different hash', async () => {
    const requested = hash('c');
    const corrupted = hash('d');
    // Cache holds a plan whose body hashes to `corrupted`, keyed under `requested`.
    const redis = fakeRedis({
      [SubstrateCacheKeys.plan(tnt, pln, requested)]: JSON.stringify(
        planFor(corrupted),
      ),
    });
    const store = new DrizzleCompiledPlanStore(stubDb, redis);
    await expect(
      store.resolvePlanCached(tnt, pln, requested),
    ).rejects.toBeInstanceOf(PlatformErrorException);
  });
});
