// Unit tests for the event fan-out channel discipline.
import {describe, expect, it} from 'vitest';
import type {EventEnvelope, SemVer, TenantId} from '@hermes-one/contracts';
import {
  DEFAULT_EVENT_CHANNEL_PATTERN,
  RedisPubSubEventPublisher,
  eventChannel,
  type RedisClient,
} from './index.js';

const envelope: EventEnvelope = {
  eventId: 'evt_x1' as EventEnvelope['eventId'],
  type: 'tool.invoked',
  schemaVersion: '1.0.0' as SemVer,
  tenantId: 'tnt_a' as TenantId,
  aggregate: {type: 'audit_event', id: 'aud_x1'},
  correlationId: 'trn_x',
  causationId: null,
  occurredAt: '2026-07-14T00:00:00.000Z' as EventEnvelope['occurredAt'],
  idempotencyKey: 'tnt_a:audit_event:aud_x1:tool.invoked',
  payload: {id: 'aud_x1'},
};

describe('event pub/sub channel (tenant-scoped, never wildcard)', () => {
  it('interpolates the default pattern', () => {
    expect(
      eventChannel(DEFAULT_EVENT_CHANNEL_PATTERN, 'tnt_a', 'audit_event'),
    ).toBe('events:tnt_a:audit_event');
  });

  it('RedisPubSubEventPublisher publishes the JSON envelope to the tenant channel', async () => {
    const seen: Array<{channel: string; message: string}> = [];
    const client = {
      publish: async (channel: string, message: string) => {
        seen.push({channel, message});
      },
    } as unknown as RedisClient;
    await new RedisPubSubEventPublisher(client).publish(envelope);
    expect(seen).toHaveLength(1);
    expect(seen[0].channel).toBe('events:tnt_a:audit_event');
    expect(JSON.parse(seen[0].message)).toEqual(envelope); // EventEnvelope round-trips through JSON
  });
});
