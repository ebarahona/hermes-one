// Unit tests for the billing event fan-out contract.
import {describe, expect, it} from 'vitest';
import type {UsageRecord} from './index.js';
import {
  BillingPeriodSummary,
  assertValidMeterTotals,
  toUsageRecordOutboxInput,
} from './index.js';

const record = {
  dedupeKey: 'prn_x:trn_y:tool.invocation:0',
  tenantId: 'tnt_bill',
  principalId: 'prn_x',
  meterKind: 'tool.invocation',
  quantity: 1,
  unit: 'count',
  correlationId: 'trn_y',
  turnId: 'trn_y',
  period: '2026-07',
  recordedAt: '2026-07-14T00:00:00.000Z',
} as unknown as UsageRecord;

describe('billing events', () => {
  it('toUsageRecordOutboxInput builds the exact enqueue() input, keyed by dedupeKey', () => {
    expect(toUsageRecordOutboxInput(record)).toEqual({
      tenantId: 'tnt_bill',
      aggregateType: 'usage_record',
      aggregateId: 'prn_x:trn_y:tool.invocation:0',
      eventType: 'usage.record.recorded',
      payload: record,
    });
  });

  it('assertValidMeterTotals accepts MeterKind keys and rejects strangers', () => {
    expect(() =>
      assertValidMeterTotals({'model.cost.usd': 1.2, 'tool.invocation': 3}),
    ).not.toThrow();
    expect(() => assertValidMeterTotals({'made.up.meter': 1})).toThrow(
      /invalid meterKind/,
    );
  });

  it('BillingPeriodSummary validates the summarize() wrapper shape', () => {
    expect(() =>
      BillingPeriodSummary.parse({
        tenantId: 'tnt_bill',
        period: '2026-07',
        totals: {'model.cost.usd': 0.42},
        summarizedAt: '2026-07-14T00:00:00.000Z',
      }),
    ).not.toThrow();
    expect(() =>
      BillingPeriodSummary.parse({
        tenantId: 'tnt_bill',
        period: 'july',
        totals: {},
        summarizedAt: 'x',
      }),
    ).toThrow();
  });
});
