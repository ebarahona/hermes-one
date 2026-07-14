// @platform-internal/redis — infrastructure (none plane).
// Ephemeral store: cache / idempotency / locks / debounce / pub-sub (ADR-006: Redis is a cache,
// never the source of truth). Exposes a narrow client port so adapters depend on the interface,
// not on ioredis directly.
import {Redis} from 'ioredis';

/**
 * The narrow surface the platform's cache-through adapters consume, bound at `platform.data.redis`.
 * Kept minimal on purpose — string keys, string values, explicit TTL, explicit invalidation.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  /** SET key value with an expiry (seconds). TTL 0 means no expiry. */
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
  close(): Promise<void>;
}

/** Connect and return a RedisClient. The URL is injected (from config) — no env read here. */
export function createRedisClient(url: string): RedisClient {
  const redis = new Redis(url, {maxRetriesPerRequest: 3});
  return {
    get: key => redis.get(key),
    setex: async (key, ttlSeconds, value) => {
      if (ttlSeconds > 0) await redis.set(key, value, 'EX', ttlSeconds);
      else await redis.set(key, value);
    },
    del: async key => {
      await redis.del(key);
    },
    close: async () => {
      await redis.quit();
    },
  };
}

export const descriptor = {
  name: '@platform-internal/redis',
  role: 'infrastructure',
  plane: 'none',
  published: false,
  sourceDocs: ['08-data/082'],
  governedBy: ['ADR-006'],
} as const;
