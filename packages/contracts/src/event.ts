// @platform/contracts — src/event.ts
// The event envelope + transactional-outbox contracts, transcribed VERBATIM from
// events/event-envelope.md. The spec authors this file itself ("NEW FILE — not yet part of the
// ratified Pack A contracts/ set; authored here to fill the gap flagged by database/postgres-schema.md").
// Zod-v4 delta (flagged, same as analytics.ts): `z.record` requires an explicit key schema.
import {z} from 'zod';
import {TenantId, IsoTimestamp, SemVer} from './substrate.js';

/* ------------------------------ Identity -------------------------------- */

/** NEW branded id (prefix `evt_`) — flagged for merge into substrate.ts's branded-ID block. */
export const EventId = z.string().min(5).startsWith('evt_').brand('EventId');
export type EventId = z.infer<typeof EventId>;

/** Dot-namespaced event type: `<domain>.<subject>.<verb>`, e.g. `workflow.execution.completed`. */
export const EventType = z
  .string()
  .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,3}$/, 'expected "domain.subject.verb"');
export type EventType = z.infer<typeof EventType>;

/* ------------------------------- Envelope -------------------------------- */

export const EventAggregateRef = z.object({
  /** Free-form (matches `event.event_outbox.aggregate_type`, an untyped `text` column — extensible,
   *  not a closed enum). Documented values in use: `events/domain-events.md`, `events/billing-events.md`. */
  type: z.string().min(1),
  id: z.string().min(1),
});
export type EventAggregateRef = z.infer<typeof EventAggregateRef>;

export const EventTrace = z.object({
  traceId: z.string().optional(),
  spanId: z.string().optional(),
});
export type EventTrace = z.infer<typeof EventTrace>;

/**
 * The one wire/storage shape every published platform event uses. Aligned with `audit-contracts.md`:
 * `correlationId` mirrors `AuditEvent.correlationId`/`UsageEvent.correlationId` (= turnId at turn
 * scope); the envelope's own `idempotencyKey` generalizes `UsageRecord.dedupeKey` to any aggregate.
 */
export const EventEnvelope = z.object({
  eventId: EventId,
  type: EventType,
  /** Schema version of THIS event type's payload shape (independent per `type`, not global). */
  schemaVersion: SemVer,
  tenantId: TenantId,
  aggregate: EventAggregateRef,
  /** Causal chain root — correlationId = turnId at turn scope (audit-contracts.md convention). */
  correlationId: z.string().min(1),
  /** The event/command that directly produced this one; null for a root cause. */
  causationId: z.string().min(1).nullable(),
  occurredAt: IsoTimestamp,
  /** Stable across republish/redelivery — consumer's at-least-once dedupe key. */
  idempotencyKey: z.string().min(1),
  /** Typed per `type` — see events/domain-events.md and events/billing-events.md for the catalog. */
  payload: z.record(z.string(), z.unknown()),
  trace: EventTrace.optional(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/* --------------------------- Outbox storage shape ------------------------ */
// Mirrors `event.event_outbox` column-for-column (database/table-catalog.md — reused, not redefined).

export interface EventOutboxRow {
  outboxId: string; // 'obx_...', storage-only PK
  sequence: bigint; // bigserial poll cursor, NOT the PK
  tenantId: TenantId;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>; // the domain payload (e.g. an AuditEvent/UsageRecord JSON body)
  status: 'pending' | 'published' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: IsoTimestamp;
  publishedAt: IsoTimestamp | null;
}

/** Write side — bound in the SAME transaction as the domain row (commit-and-publish). */
export interface EventOutboxRepository {
  enqueue(
    row: Pick<EventOutboxRow, 'tenantId' | 'aggregateType' | 'aggregateId' | 'eventType' | 'payload'>,
    tx: unknown, // the caller's open Drizzle transaction (ADR-022) — never opens its own
  ): Promise<void>;
  /** Poller read — ORDER BY sequence, status='pending'. */
  pollPending(limit: number): Promise<EventOutboxRow[]>;
  markPublished(outboxId: string): Promise<void>;
  markFailed(outboxId: string, error: string): Promise<void>;
}

/** Dispatch side — fans an envelope out to Redis pub/sub (ephemeral) or a future broker. */
export interface EventPublisher {
  publish(envelope: EventEnvelope): Promise<void>;
}

/** Pure mapper — outbox row (storage) → envelope (wire). No I/O. */
export function toEventEnvelope(row: EventOutboxRow, schemaVersion: SemVer): EventEnvelope {
  return {
    eventId: EventId.parse(`evt_${row.outboxId.replace(/^obx_/, '')}`),
    type: row.eventType,
    schemaVersion,
    tenantId: row.tenantId,
    aggregate: {type: row.aggregateType, id: row.aggregateId},
    correlationId: (row.payload.correlationId as string | undefined) ?? row.aggregateId,
    causationId: (row.payload.causationId as string | undefined) ?? null,
    occurredAt: row.createdAt,
    idempotencyKey: deriveEventIdempotencyKey({
      tenantId: row.tenantId,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
    }),
    payload: row.payload,
  };
}

/** Stable regardless of publish attempt count — consumer dedupe key (same pattern as `deriveDedupeKey`). */
export function deriveEventIdempotencyKey(input: {
  tenantId: TenantId;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
}): string {
  return `${input.tenantId}:${input.aggregateType}:${input.aggregateId}:${input.eventType}`;
}
