// event.event_outbox writer + publisher read-side — the transactional-outbox "commit-and-publish"
// store (`EventOutboxRepository`). `enqueue`
// joins the CALLER's open tenant transaction (never opens its own) so the outbox row commits
// atomically with the domain row it fans out from. Idempotent on outbox_id: the caller derives a
// deterministic id from the aggregate (e.g. `obx_<audit id>`), so a Temporal activity replay
// collapses to one row.
//
// Publish semantics: the publisher polls `status='pending' ORDER BY sequence
// LIMIT N FOR UPDATE SKIP LOCKED` (LISTEN/NOTIFY is not used under transaction
// pooling); a failed publish increments `attempts` and stays `pending` until `maxAttempts`, then
// flips to `failed` and is excluded from polling. At-least-once: a crash after PUBLISH but before
// COMMIT republishes — consumers dedupe on the envelope's deterministic `idempotencyKey`.
//
// FLAGGED: the poll is PER-TENANT (withTenant → RLS) because the cross-tenant relay role
// (`platform-admin`) is an UNRESOLVED question — this
// build never invents a bypass-capable role. The tenant list is injected (config stand-in; the real
// source is the tenant registry, blocked on CT1).
import {and, asc, eq, sql} from 'drizzle-orm';
import type {
  EventEnvelope,
  EventOutboxRepository,
  EventOutboxRow,
  IsoTimestamp,
  SemVer,
  TenantId,
} from '@platform/contracts';
import {toEventEnvelope} from '@platform/contracts';
import {TenantAwareRepository, type PlatformDb, type PlatformTx} from './tenant-aware.repository.js';
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

/** Deterministic storage id: one outbox row per aggregate row (stable across activity replays). */
export function deriveOutboxId(aggregateId: string): string {
  return `obx_${aggregateId.replace(/^[a-z]+_/, '')}`;
}

export interface OutboxDrainResult {
  published: number;
  failed: number;
}

export class DrizzleEventOutboxRepository extends TenantAwareRepository implements EventOutboxRepository {
  constructor(
    db: PlatformDb,
    /** `outboxMaxAttempts` (EventEnvelopeConfig, default 10): pending→failed threshold. */
    private readonly maxAttempts: number = 10,
  ) {
    super(db);
  }

  /** Canonical port shape: joins the caller's open transaction; derives the outbox id from the aggregate. */
  async enqueue(
    row: Pick<EventOutboxRow, 'tenantId' | 'aggregateType' | 'aggregateId' | 'eventType' | 'payload'>,
    tx: unknown,
  ): Promise<void> {
    await enqueueOutboxRow(tx as PlatformTx, {...row, outboxId: deriveOutboxId(row.aggregateId)});
  }

  /**
   * Poller read — ORDER BY sequence, status='pending'. Tenant-scoped when a tenant is given; the
   * no-tenant port overload fail-closes to [] under strict RLS as platform_app (flagged above).
   */
  async pollPending(limit: number): Promise<EventOutboxRow[]>;
  async pollPending(limit: number, tenantId?: TenantId): Promise<EventOutboxRow[]> {
    const run = async (tx: PlatformTx) => {
      const rows = await tx
        .select()
        .from(eventOutbox)
        .where(eq(eventOutbox.status, 'pending'))
        .orderBy(asc(eventOutbox.sequence))
        .limit(limit);
      return rows.map(r => this.toRow(r));
    };
    if (tenantId) return this.withTenant({tenantId}, run);
    return this.db.transaction(run);
  }

  async markPublished(outboxId: string): Promise<void> {
    await this.db
      .update(eventOutbox)
      .set({status: 'published', publishedAt: new Date()})
      .where(eq(eventOutbox.outboxId, outboxId));
  }

  /** attempts++; stays `pending` (retried next poll) until maxAttempts, then `failed` (excluded). */
  async markFailed(outboxId: string, error: string): Promise<void> {
    await this.db
      .update(eventOutbox)
      .set({
        attempts: sql`${eventOutbox.attempts} + 1`,
        lastError: error,
        status: sql`CASE WHEN ${eventOutbox.attempts} + 1 >= ${this.maxAttempts} THEN 'failed' ELSE 'pending' END`,
      })
      .where(eq(eventOutbox.outboxId, outboxId));
  }

  /**
   * One publisher pass for one tenant: claim up to `limit` pending rows (`FOR UPDATE SKIP LOCKED` —
   * concurrent publisher instances never double-claim), map each to its EventEnvelope, publish, and
   * mark published/failed in the SAME transaction. A crash between PUBLISH and COMMIT republishes
   * next pass (at-least-once; consumers dedupe on idempotencyKey).
   */
  async drainPending(
    tenantId: TenantId,
    limit: number,
    publish: (envelope: EventEnvelope) => Promise<void>,
    schemaVersionFor: (eventType: string) => SemVer,
  ): Promise<OutboxDrainResult> {
    return this.withTenant({tenantId}, async tx => {
      const rows = await tx
        .select()
        .from(eventOutbox)
        .where(and(eq(eventOutbox.status, 'pending'), eq(eventOutbox.tenantId, tenantId)))
        .orderBy(asc(eventOutbox.sequence))
        .limit(limit)
        .for('update', {skipLocked: true});

      const result: OutboxDrainResult = {published: 0, failed: 0};
      for (const raw of rows) {
        const row = this.toRow(raw);
        try {
          await publish(toEventEnvelope(row, schemaVersionFor(row.eventType)));
          await tx
            .update(eventOutbox)
            .set({status: 'published', publishedAt: new Date()})
            .where(eq(eventOutbox.outboxId, row.outboxId));
          result.published += 1;
        } catch (err) {
          await tx
            .update(eventOutbox)
            .set({
              attempts: sql`${eventOutbox.attempts} + 1`,
              lastError: String((err as Error).message ?? err),
              status: sql`CASE WHEN ${eventOutbox.attempts} + 1 >= ${this.maxAttempts} THEN 'failed' ELSE 'pending' END`,
            })
            .where(eq(eventOutbox.outboxId, row.outboxId));
          result.failed += 1;
        }
      }
      return result;
    });
  }

  private toRow(r: typeof eventOutbox.$inferSelect): EventOutboxRow {
    return {
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
    };
  }
}
