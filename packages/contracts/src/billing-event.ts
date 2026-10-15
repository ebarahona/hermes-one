// @platform/contracts — src/billing-event.ts
// Billing event fan-out, hosted in contracts with the rest of the event family.
// References @platform/contracts types; introduces no new metering model (T7: the UsageMeter stays
// the single billing source; these are its fan-out envelopes).
import {z} from 'zod';
import {MeterKind, UsageRecord} from './audit.js';
import {TenantId} from './substrate.js';
import type {EventEnvelope} from './event.js';

export const BillingEventType = z.enum([
  'usage.record.recorded',
  'billing.period.summarized',
]);
export type BillingEventType = z.infer<typeof BillingEventType>;

/** Payload for `billing.period.summarized` — the exact shape `UsageMeter.summarize()` already returns,
 *  wrapped with the tenant/period it was computed for (the audit contract defines the method; this is
 *  just its event envelope). */
export const BillingPeriodSummary = z.object({
  tenantId: TenantId,
  period: z.string().regex(/^\d{4}-\d{2}$/),
  /** Keyed by MeterKind — z.record can't express the enum-key constraint directly; validated by refinement. */
  totals: z.record(z.string(), z.number().nonnegative()),
  summarizedAt: z.string().datetime({offset: true}),
});
export type BillingPeriodSummary = z.infer<typeof BillingPeriodSummary>;

export interface BillingEventPayloadMap {
  'usage.record.recorded': UsageRecord;
  'billing.period.summarized': BillingPeriodSummary;
}

export type BillingEventEnvelope<
  T extends BillingEventType = BillingEventType,
> = EventEnvelope & {
  type: T;
  payload: BillingEventPayloadMap[T];
};

/** Pure — builds the outbox `enqueue()` input from a just-inserted UsageRecord. Called inside the
 *  SAME transaction as the `ON CONFLICT DO NOTHING` insert, only when `inserted:true`. */
export function toUsageRecordOutboxInput(record: UsageRecord) {
  return {
    tenantId: record.tenantId,
    aggregateType: 'usage_record' as const,
    aggregateId: record.dedupeKey,
    eventType: 'usage.record.recorded' as const,
    payload: record as unknown as Record<string, unknown>,
  };
}

/** Validates that `totals`'s keys are a subset of MeterKind before an envelope is built. */
export function assertValidMeterTotals(totals: Record<string, number>): void {
  const valid = new Set<string>(MeterKind.options);
  for (const key of Object.keys(totals)) {
    if (!valid.has(key)) throw new Error(`invalid meterKind in totals: ${key}`);
  }
}
