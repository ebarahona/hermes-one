// event.event_outbox writer — the transactional-outbox "commit-and-publish" write side
// (events/event-envelope.md `EventOutboxRepository`, database/table-catalog.md). `enqueue` joins the
// CALLER's open tenant transaction (never opens its own) so the outbox row commits atomically with the
// domain row it fans out from. Idempotent on outbox_id: the caller derives a deterministic id from the
// aggregate (e.g. `obx_<audit id>`), so a Temporal activity replay collapses to one row.
//
// FLAGGED (F2 follow-up — the RELAY): pollPending/markPublished/markFailed implement the port for the
// publisher loop, but event_outbox is RLS 'strict' and the port's pollPending(limit) carries no tenant —
// run as plain platform_app with no GUC it fail-closes to zero rows. The real cross-tenant publisher
// needs the privileged aggregator posture (same open question as the platform-wide analytics rollup);
// the poller loop + Redis pub/sub dispatch are not wired yet (DEFERRED-AND-FLAGGED E4/AU-outbox).
import {asc, eq, sql} from 'drizzle-orm';
import type {EventOutboxRepository, EventOutboxRow, IsoTimestamp, TenantId} from '@platform/contracts';
import {TenantAwareRepository, type PlatformTx} from './tenant-aware.repository.js';
import {eventOutbox} from './schema/event.schema.js';

export type OutboxEnqueueRow = Pick<
  EventOutboxRow,
  'tenantId' | 'aggregateType' | 'aggregateId' | 'eventType' | 'payload'
> & {outboxId: string};

/**
 * Tx-scoped write core: insert one pending outbox row inside the caller's open tenant transaction.
 * The deterministic `outboxId` is the replay-collapse key (ON CONFLICT DO NOTHING on the PK).
 */
export async function enqueueOutboxRow(tx: PlatformTx, row: OutboxEnqueueRow): Promise<void> {
  await tx
    .insert(eventOutbox)
    .values({
      outboxId: row.outboxId,
      tenantId: row.tenantId,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload,
      status: 'pending',
    })
    .onConflictDoNothing({target: eventOutbox.outboxId});
}

export class DrizzleEventOutboxRepository extends TenantAwareRepository implements EventOutboxRepository {
  /** Canonical port shape: joins the caller's open transaction; derives the outbox id from the aggregate. */
  async enqueue(
    row: Pick<EventOutboxRow, 'tenantId' | 'aggregateType' | 'aggregateId' | 'eventType' | 'payload'>,
    tx: unknown,
  ): Promise<void> {
    await enqueueOutboxRow(tx as PlatformTx, {...row, outboxId: deriveOutboxId(row.aggregateId)});
  }

  /** Poller read — ORDER BY sequence, status='pending'. See the RLS flag in the header. */
  async pollPending(limit: number): Promise<EventOutboxRow[]>;
  async pollPending(limit: number, tenantId?: TenantId): Promise<EventOutboxRow[]> {
    const run = async (tx: PlatformTx) => {
      const rows = await tx
        .select()
        .from(eventOutbox)
        .where(eq(eventOutbox.status, 'pending'))
        .orderBy(asc(eventOutbox.sequence))
        .limit(limit);
      return rows.map(r => ({
        outboxId: r.outboxId,
        sequence: BigInt(r.sequence),
        tenantId: r.tenantId as TenantId,
        aggregateType: r.aggregateType,
        aggregateId: r.aggregateId,
        eventType: r.eventType,
        payload: (r.payload ?? {}) as Record<string, unknown>,
        status: r.status,
        attempts: r.attempts,
        lastError: r.lastError ?? null,
        createdAt: r.createdAt.toISOString() as IsoTimestamp,
        publishedAt: (r.publishedAt?.toISOString() ?? null) as IsoTimestamp | null,
      }));
    };
    // Tenant-scoped poll when a tenant is given (tests / per-tenant relay); the no-tenant overload
    // fail-closes to [] under RLS until the privileged publisher posture exists (flagged above).
    if (tenantId) return this.withTenant({tenantId}, run);
    return this.db.transaction(run);
  }

  async markPublished(outboxId: string): Promise<void> {
    await this.db
      .update(eventOutbox)
      .set({status: 'published', publishedAt: new Date()})
      .where(eq(eventOutbox.outboxId, outboxId));
  }

  async markFailed(outboxId: string, error: string): Promise<void> {
    await this.db
      .update(eventOutbox)
      .set({status: 'failed', lastError: error, attempts: sql`${eventOutbox.attempts} + 1`})
      .where(eq(eventOutbox.outboxId, outboxId));
  }
}

/** Deterministic storage id: one outbox row per aggregate row (stable across activity replays). */
export function deriveOutboxId(aggregateId: string): string {
  return `obx_${aggregateId.replace(/^[a-z]+_/, '')}`;
}
