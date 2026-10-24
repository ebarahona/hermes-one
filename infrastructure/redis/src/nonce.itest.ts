// Live-Redis itest for the replay guard (AUTH-1): a nonce reserves exactly once within its TTL.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {loadConfig} from '@hermes-one/config';
import {RedisNonceStore, createRedisClient, type RedisClient} from './index.js';

const cfg = loadConfig();
let redis: RedisClient;

beforeAll(() => {
  redis = createRedisClient(cfg.stores.ephemeral.url);
});
afterAll(async () => {
  await redis.close();
});

describe('RedisNonceStore (live)', () => {
  it('reserves a fresh nonce once; the second reserve is a replay', async () => {
    const store = new RedisNonceStore(redis);
    const key = `itest:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    expect(await store.reserve(key, 60)).toBe(true);
    expect(await store.reserve(key, 60)).toBe(false); // replay
    await redis.del(`auth:nonce:${key}`);
  });

  it('a nonce expires with its TTL (skew window) and can be reserved again', async () => {
    const store = new RedisNonceStore(redis);
    const key = `itest:ttl:${Date.now()}`;
    expect(await store.reserve(key, 1)).toBe(true);
    await new Promise(r => setTimeout(r, 1100));
    expect(await store.reserve(key, 1)).toBe(true); // window passed → fresh again
    await redis.del(`auth:nonce:${key}`);
  });
});
