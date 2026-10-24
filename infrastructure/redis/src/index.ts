// @hermes-one/redis — infrastructure (none plane).
// Ephemeral store: cache / idempotency / locks / debounce / pub-sub (ADR-006: Redis is a cache,
// never the source of truth). Exposes a narrow client port so adapters depend on the interface,
// not on ioredis directly.
import {Redis} from 'ioredis';
import type {EventEnvelope, EventPublisher} from '@hermes-one/contracts';

/**
 * The narrow surface the platform's cache-through adapters consume, bound at `platform.data.redis`.
 * Kept minimal on purpose — string keys, string values, explicit TTL, explicit invalidation.
 * Pub/sub is FAN-OUT ONLY (a subscriber that misses a message re-derives
 * from the outbox/domain table — no replay-from-Redis path exists).
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  /** SET key value with an expiry (seconds). TTL 0 means no expiry. */
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
  /** PUBLISH one message to a channel (pub/sub lane). */
  publish(channel: string, message: string): Promise<void>;
  /** SET key value EX ttl NX — true if freshly set, false if the key already exists (idempotency lane). */
  setnx(key: string, ttlSeconds: number, value: string): Promise<boolean>;
  /**
   * SUBSCRIBE on a DEDICATED duplicated connection (ioredis requires a subscriber connection to do
   * nothing else). Returns an unsubscribe that closes that dedicated connection.
   */
  subscribe(
    channel: string,
    onMessage: (message: string) => void,
  ): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** Connect and return a RedisClient. The URL is injected (from config) — no env read here. */
export function createRedisClient(url: string): RedisClient {
  const redis = new Redis(url, {maxRetriesPerRequest: 3});
  const subscribers = new Set<Redis>();
  return {
    get: key => redis.get(key),
    setex: async (key, ttlSeconds, value) => {
      if (ttlSeconds > 0) await redis.set(key, value, 'EX', ttlSeconds);
      else await redis.set(key, value);
    },
    del: async key => {
      await redis.del(key);
    },
    publish: async (channel, message) => {
      await redis.publish(channel, message);
    },
    setnx: async (key, ttlSeconds, value) => {
      const res = await redis.set(
        key,
        value,
        'EX',
        Math.max(1, ttlSeconds),
        'NX',
      );
      return res === 'OK';
    },
    subscribe: async (channel, onMessage) => {
      const sub = redis.duplicate();
      subscribers.add(sub);
      await sub.subscribe(channel);
      sub.on('message', (ch: string, message: string) => {
        if (ch === channel) onMessage(message);
      });
      return async () => {
        subscribers.delete(sub);
        await sub.quit();
      };
    },
    close: async () => {
      await Promise.all([...subscribers].map(s => s.quit()));
      subscribers.clear();
      await redis.quit();
    },
  };
}

/* ---------------- Replay guard (NonceStore) ---------------- */

/**
 * Redis-backed single-use nonce guard for stateless credentials (signed webhooks, workload tokens).
 * Canonical port shape — hosted here until the auth
 * component (`components/auth`, AUTH-3) lands and re-exports it (flagged,
 * docs/design/001-edge-authn-design.md).
 */
export interface NonceStore {
  /** true if freshly reserved; false if already seen (replay). */
  reserve(key: string, ttlSeconds: number): Promise<boolean>;
}

export class RedisNonceStore implements NonceStore {
  constructor(private readonly client: RedisClient) {}
  reserve(key: string, ttlSeconds: number): Promise<boolean> {
    return this.client.setnx(`auth:nonce:${key}`, ttlSeconds, '1');
  }
}

/* ------------------- Event fan-out ------------------- */

/** The default `channelPattern` in EventEnvelopeConfig. Never a cross-tenant wildcard. */
export const DEFAULT_EVENT_CHANNEL_PATTERN =
  'events:{tenantId}:{aggregateType}';

/** The ONE place the event pub/sub channel string is constructed. */
export function eventChannel(
  pattern: string,
  tenantId: string,
  aggregateType: string,
): string {
  return pattern
    .replace('{tenantId}', tenantId)
    .replace('{aggregateType}', aggregateType);
}

/**
 * `platform.data.event-outbox-publisher`'s dispatch side: fans an EventEnvelope out to the
 * tenant-scoped Redis pub/sub channel (`events:{tenantId}:{aggregateType}`). At-least-once —
 * consumers dedupe on `envelope.idempotencyKey`.
 */
export class RedisPubSubEventPublisher implements EventPublisher {
  constructor(
    private readonly client: RedisClient,
    private readonly channelPattern: string = DEFAULT_EVENT_CHANNEL_PATTERN,
  ) {}

  async publish(envelope: EventEnvelope): Promise<void> {
    await this.client.publish(
      eventChannel(
        this.channelPattern,
        envelope.tenantId,
        envelope.aggregate.type,
      ),
      JSON.stringify(envelope),
    );
  }
}

export const descriptor = {
  name: '@hermes-one/redis',
  role: 'infrastructure',
  plane: 'none',
  published: false,
  governedBy: ['ADR-006'],
} as const;
