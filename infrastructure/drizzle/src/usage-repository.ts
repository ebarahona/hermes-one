// Tenant-scoped usage meter for audit.usage_records (RLS 'strict') — the store behind platform.usage.meter
// Implements the canonical UsageMeter port. `record` upserts ON CONFLICT(dedupe_key)
// DO NOTHING so at-least-once emission (Temporal retries / actor replays) collapses to exactly-once billing
// (findings T7); it aggregates its input events, it does not re-derive tokens/cost. All access goes through
// withTenant → set_config('app.tenant_id'). quantity is a Postgres numeric (string over the wire) — parsed
// to number on summarize.
import {and, eq, sql} from 'drizzle-orm';
import type {
  MeterKind,
  TenantId,
  UsageEvent,
  UsageMeter,
} from '@hermes-one/contracts';
import {
  TenantAwareRepository,
  type PlatformTx,
} from './tenant-aware.repository.js';
import {usageRecords} from './schema/audit.schema.js';

const ALL_METER_KINDS: MeterKind[] = [
  'model.input.tokens',
  'model.output.tokens',
  'model.cost.usd',
  'tool.invocation',
  'message.sent',
  'storage.vector',
];

/** Tx-scoped write core (shared with the atomic DrizzleTurnPersistence writer). */
export async function insertUsageRecord(
  tx: PlatformTx,
  event: UsageEvent,
): Promise<{inserted: boolean}> {
  const period = event.emittedAt.slice(0, 7); // 'YYYY-MM' from the ISO timestamp
  const res = await tx
    .insert(usageRecords)
    .values({
      dedupeKey: event.dedupeKey,
      tenantId: event.tenantId,
      principalId: event.principalId,
      meterKind: event.meterKind,
      quantity: String(event.quantity),
      unit: event.unit,
      correlationId: event.correlationId,
      turnId: event.turnId ?? undefined,
      period,
      recordedAt: new Date(event.emittedAt),
    })
    .onConflictDoNothing({target: usageRecords.dedupeKey});
  return {inserted: (res.rowCount ?? 0) > 0};
}

export class DrizzleUsageMeter
  extends TenantAwareRepository
  implements UsageMeter
{
  /** Idempotent on dedupeKey — a re-emitted event is a no-op (exactly-once billing). `inserted` says which. */
  async record(event: UsageEvent): Promise<{inserted: boolean}> {
    return this.withTenant({tenantId: event.tenantId}, tx =>
      insertUsageRecord(tx, event),
    );
  }

  /** Count distinct turns that called the model in a period (one model.cost.usd row per model turn).
   *  The denominator for the LLM-turn side of the scalability KPIs. */
  async countModelTurns(tenantId: TenantId, period: string): Promise<number> {
    return this.withTenant({tenantId}, async tx => {
      const rows = await tx
        .select({n: sql<number>`count(distinct ${usageRecords.turnId})::int`})
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.tenantId, tenantId),
            eq(usageRecords.period, period),
            eq(usageRecords.meterKind, 'model.cost.usd'),
          ),
        );
      return rows[0]?.n ?? 0;
    });
  }

  /** Sum billable quantity per meter kind for a tenant + billing period. */
  async summarize(
    tenantId: TenantId,
    period: string,
  ): Promise<Record<MeterKind, number>> {
    return this.withTenant({tenantId}, async tx => {
      const rows = await tx
        .select({
          meterKind: usageRecords.meterKind,
          total: sql<string>`sum(${usageRecords.quantity})`,
        })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.tenantId, tenantId),
            eq(usageRecords.period, period),
          ),
        )
        .groupBy(usageRecords.meterKind);
      const out = Object.fromEntries(
        ALL_METER_KINDS.map(k => [k, 0]),
      ) as Record<MeterKind, number>;
      for (const r of rows) out[r.meterKind] = Number(r.total);
      return out;
    });
  }
}
