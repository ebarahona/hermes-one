import {describe, expect, it} from 'vitest';
import type {
  MeterKind,
  TenantId,
  UsageEvent,
  UsageMeter,
} from '@hermes-one/contracts';
import {UsageCostAnalyticsService} from './cost-analytics.js';

const T = 'tnt_a' as TenantId;
const CLOCK = () => new Date('2026-08-01T00:00:00.000Z');

const platformTotals: Record<MeterKind, number> = {
  'model.input.tokens': 1000,
  'model.output.tokens': 300,
  'model.cost.usd': 0.01,
  'tool.invocation': 2,
  'message.sent': 0,
  'storage.vector': 0,
};

/** A UsageMeter whose summarize returns fixed totals (record is unused here). */
const fakeMeter = (totals: Record<MeterKind, number>): UsageMeter => ({
  record: async (_e: UsageEvent) => ({inserted: true}),
  summarize: async () => totals,
});

describe('UsageCostAnalyticsService', () => {
  it('summarize is a pass-through to UsageMeter.summarize (no second counter)', async () => {
    const svc = new UsageCostAnalyticsService(
      fakeMeter(platformTotals),
      async () => ({}),
      {clock: CLOCK},
    );
    expect(await svc.summarize(T, '2026-07')).toEqual(platformTotals);
  });

  it('reconcile reports ok with empty deltas when agentback matches within tolerance', async () => {
    const svc = new UsageCostAnalyticsService(
      fakeMeter(platformTotals),
      async () => ({...platformTotals}), // identical export
      {toleranceDiffPct: 1, clock: CLOCK},
    );
    const r = await svc.reconcile(T, '2026-07');
    expect(r.status).toBe('ok');
    expect(r.deltas).toEqual({});
    expect(r.toleranceDiffPct).toBe(1);
  });

  it('reconcile reports drift with per-meter deltas when a meter exceeds tolerance', async () => {
    const svc = new UsageCostAnalyticsService(
      fakeMeter(platformTotals),
      // agentback says cost is 20% lower and input tokens 10% higher; others match.
      async () => ({
        ...platformTotals,
        'model.cost.usd': 0.0125,
        'model.input.tokens': 909,
      }),
      {toleranceDiffPct: 1, clock: CLOCK},
    );
    const r = await svc.reconcile(T, '2026-07');
    expect(r.status).toBe('drift');
    expect(Object.keys(r.deltas).sort()).toEqual([
      'model.cost.usd',
      'model.input.tokens',
    ]);
    // platform 0.01 vs agentback 0.0125 → -20%
    expect(r.deltas['model.cost.usd']!.diffPct).toBeCloseTo(-20, 5);
    expect(r.deltas['model.cost.usd']!.platformTotal).toBe(0.01);
    expect(r.deltas['model.cost.usd']!.agentbackTotal).toBe(0.0125);
    // matching meters are NOT in the deltas
    expect(r.deltas['tool.invocation']).toBeUndefined();
  });

  it('treats a meter agentback omits (0) but the platform has as 100% drift', async () => {
    const svc = new UsageCostAnalyticsService(
      fakeMeter({...platformTotals, 'storage.vector': 5}),
      async () => ({...platformTotals}), // agentback has no storage.vector
      {toleranceDiffPct: 1, clock: CLOCK},
    );
    const r = await svc.reconcile(T, '2026-07');
    expect(r.status).toBe('drift');
    expect(r.deltas['storage.vector']).toEqual({
      platformTotal: 5,
      agentbackTotal: 0,
      diffPct: 100,
    });
  });
});
