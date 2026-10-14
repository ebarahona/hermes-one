// Unit tests for the event-envelope contract.
import {describe, expect, it} from 'vitest';
import type {EventOutboxRow, IsoTimestamp, SemVer, TenantId} from './index.js';
import {EventEnvelope, deriveEventIdempotencyKey, toEventEnvelope} from './index.js';

const row: EventOutboxRow = {
  outboxId: 'obx_7f1',
  sequence: 482910n,
  tenantId: 'tnt_acme' as TenantId,
  aggregateType: 'audit_event',
  aggregateId: 'aud_7f1',
  eventType: 'tool.invoked',
  payload: {id: 'aud_7f1', action: 'tool.invoked', correlationId: 'trn_01J8'},
  status: 'pending',
  attempts: 0,
  lastError: null,
  createdAt: '2026-07-13T00:00:00.000Z' as IsoTimestamp,
  publishedAt: null,
};

describe('toEventEnvelope (outbox row → wire shape)', () => {
  it('maps every field and validates against the EventEnvelope contract', () => {
    const env = toEventEnvelope(row, '1.0.0' as SemVer);
    expect(() => EventEnvelope.parse(env)).not.toThrow();
    expect(env.eventId).toBe('evt_7f1');
    expect(env.type).toBe('tool.invoked');
    expect(env.aggregate).toEqual({type: 'audit_event', id: 'aud_7f1'});
    expect(env.correlationId).toBe('trn_01J8'); // taken from the payload when present
    expect(env.causationId).toBeNull();
    expect(env.payload).toBe(row.payload);
  });

  it('idempotencyKey is stable across republish (attempt count plays no part)', () => {
    const a = toEventEnvelope(row, '1.0.0' as SemVer);
    const b = toEventEnvelope({...row, attempts: 3, status: 'failed'}, '1.0.0' as SemVer);
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.idempotencyKey).toBe(
      deriveEventIdempotencyKey({
        tenantId: row.tenantId, aggregateType: 'audit_event', aggregateId: 'aud_7f1', eventType: 'tool.invoked',
      }),
    );
  });

  it('falls back to the aggregateId as correlationId when the payload has none', () => {
    const env = toEventEnvelope({...row, payload: {id: 'aud_7f1'}}, '1.0.0' as SemVer);
    expect(env.correlationId).toBe('aud_7f1');
  });
});
