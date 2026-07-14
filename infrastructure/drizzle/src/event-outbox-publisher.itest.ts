// Integration test against the live backing stack (Postgres :5433, Redis :6380). Proves the
// transactional-outbox PUBLISHER (events/event-envelope.md): pending rows drain in sequence order to
// the tenant-scoped Redis pub/sub channel, publish marks rows `published`, a failing publish
// increments attempts and stays `pending` until maxAttempts then flips `failed` (excluded), and a
// tenant-B subscriber never sees tenant-A envelopes.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@platform-internal/config';
import {createRedisClient, RedisPubSubEventPublisher, type RedisClient} from '@platform-internal/redis';
import {EventEnvelope, type TenantId} from '@platform/contracts';
import {runMigrations} from './migrate.js';
import {createEventOutboxRepository, type EventOutboxRepositoryHandle} from './client.js';
import {EventOutboxPublisherLoop} from './event-outbox-publisher.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const REDIS = cfg.stores.ephemeral.url;
const TENANT_A = 'tnt_obx_a' as TenantId;
const TENANT_B = 'tnt_obx_b' as TenantId;
const MAX_ATTEMPTS = 3;

let owner: Pool;
let redis: RedisClient;
let outbox: EventOutboxRepositoryHandle;

const seed = async (outboxId: string, tenantId: string, n: number) => {
  await owner.query(
    `INSERT INTO event.event_outbox (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, $2, 'audit_event', $3, 'tool.invoked', $4)`,
    [outboxId, tenantId, `aud_${outboxId}`, JSON.stringify({id: `aud_${outboxId}`, n, correlationId: 'trn_obx'})],
  );
};

const rowState = async (outboxId: string): Promise<{status: string; attempts: number}> => {
  const r = await owner.query(`SELECT status, attempts FROM event.event_outbox WHERE outbox_id = $1`, [outboxId]);
  return r.rows[0];
};

const wipe = async () => {
  await owner.query(`DELETE FROM event.event_outbox WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
};

beforeAll(async () => {
  await runMigrations(PG);
  owner = new Pool({connectionString: PG, max: 2});
  redis = createRedisClient(REDIS);
  outbox = createEventOutboxRepository(PG, {maxAttempts: MAX_ATTEMPTS});
  await wipe();
});

afterAll(async () => {
  await wipe();
  await owner.end();
  await redis.close();
  await outbox.close();
});

describe('EventOutboxPublisherLoop (live PG + Redis)', () => {
  it('drains pending rows in sequence order to the tenant channel and marks them published', async () => {
    await seed('obx_pub_1', TENANT_A, 1);
    await seed('obx_pub_2', TENANT_A, 2);

    const received: EventEnvelope[] = [];
    const unsubscribe = await redis.subscribe(`events:${TENANT_A}:audit_event`, m => {
      received.push(EventEnvelope.parse(JSON.parse(m)));
    });
    const bReceived: string[] = [];
    const unsubscribeB = await redis.subscribe(`events:${TENANT_B}:audit_event`, m => {
      bReceived.push(m);
    });

    const loop = new EventOutboxPublisherLoop(
      outbox.repo,
      new RedisPubSubEventPublisher(redis),
      [TENANT_A],
      {pollIntervalMs: 60_000, batchSize: 50, schemaVersionByType: {}},
    );
    const result = await loop.drainOnce();
    expect(result).toEqual({published: 2, failed: 0});

    // Pub/sub delivery is async — give the subscriber connection a beat.
    await new Promise(r => setTimeout(r, 300));
    expect(received).toHaveLength(2);
    // Sequence order preserved; envelope fields per the contract; correlationId from the payload.
    expect(received.map(e => (e.payload as {n: number}).n)).toEqual([1, 2]);
    expect(received[0].eventId).toBe('evt_pub_1');
    expect(received[0].idempotencyKey).toBe(`${TENANT_A}:audit_event:aud_obx_pub_1:tool.invoked`);
    expect(received[0].correlationId).toBe('trn_obx');
    // Tenant isolation: B's channel saw nothing (channel is tenant-scoped, never wildcard).
    expect(bReceived).toHaveLength(0);

    expect((await rowState('obx_pub_1')).status).toBe('published');
    expect((await rowState('obx_pub_2')).status).toBe('published');

    // Re-drain: published rows are excluded — nothing republished.
    expect(await loop.drainOnce()).toEqual({published: 0, failed: 0});

    await unsubscribe();
    await unsubscribeB();
  });

  it('a failing publish increments attempts, stays pending, then flips failed at maxAttempts (excluded)', async () => {
    await seed('obx_pub_bad', TENANT_A, 3);
    const boom = {publish: async () => Promise.reject(new Error('broker down'))};
    const loop = new EventOutboxPublisherLoop(outbox.repo, boom, [TENANT_A], {
      pollIntervalMs: 60_000,
      batchSize: 50,
      schemaVersionByType: {},
    });

    expect(await loop.drainOnce()).toEqual({published: 0, failed: 1});
    expect(await rowState('obx_pub_bad')).toEqual({status: 'pending', attempts: 1});

    expect(await loop.drainOnce()).toEqual({published: 0, failed: 1});
    expect(await rowState('obx_pub_bad')).toEqual({status: 'pending', attempts: 2});

    expect(await loop.drainOnce()).toEqual({published: 0, failed: 1});
    expect(await rowState('obx_pub_bad')).toEqual({status: 'failed', attempts: 3});

    // Failed rows are excluded from further polling.
    expect(await loop.drainOnce()).toEqual({published: 0, failed: 0});
  });
});
