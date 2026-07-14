import {describe, expect, it} from 'vitest';
import type {IsoTimestamp, MeterKind, ScalabilityMetrics, ScalabilityThresholds, TenantId} from '@platform/contracts';
import {
  ThresholdScalabilityRegressionGate,
  UsageScalabilityAnalyticsService,
  type ScalabilityDataSources,
} from './scalability-analytics.js';

const T = 'tnt_a' as TenantId;
const CLOCK = () => new Date('2026-08-01T00:00:00.000Z');

const totals: Record<MeterKind, number> = {
  'model.input.tokens': 2000, 'model.output.tokens': 600, 'model.cost.usd': 0.02,
  'tool.invocation': 3, 'message.sent': 0, 'storage.vector': 0,
};
const sources = (ruleDecisions: number, modelTurns: number): ScalabilityDataSources => ({
  summarize: async () => totals,
  countRuleDecisions: async () => ruleDecisions,
  countModelTurns: async () => modelTurns,
});

describe('UsageScalabilityAnalyticsService.dashboard', () => {
  it('computes deterministic_hit_rate, tokens/turn, cost/turn from decisions vs model turns', async () => {
    const svc = new UsageScalabilityAnalyticsService(sources(10, 3), CLOCK);
    const m = await svc.dashboard(T, '2026-07');
    expect(m.turns).toBe(10);
    expect(m.deterministicHitRate).toBeCloseTo(0.7, 6); // (10 - 3) / 10
    expect(m.tokensPerTurn).toBeCloseTo(260, 6);        // 2600 / 10
    expect(m.costPerTurnUsd).toBeCloseTo(0.002, 6);     // 0.02 / 10
    // pending KPIs are 0 (flagged), not fabricated
    expect(m.llmCallsPerTurn).toBe(0);
    expect(m.smallModelShare).toBe(0);
    expect(m.workerOccupancyInWait).toBe(0);
  });

  it('is 100% deterministic when no turn escalated to the model', async () => {
    const svc = new UsageScalabilityAnalyticsService(sources(5, 0), CLOCK);
    const m = await svc.dashboard(T, '2026-07');
    expect(m.deterministicHitRate).toBe(1);
  });

  it('returns zeros for an empty period (no divide-by-zero)', async () => {
    const svc = new UsageScalabilityAnalyticsService(sources(0, 0), CLOCK);
    const m = await svc.dashboard(T, '2026-07');
    expect(m).toMatchObject({turns: 0, deterministicHitRate: 0, tokensPerTurn: 0, costPerTurnUsd: 0});
  });

  it('rejects a platform-wide rollup (tenantId=null) — not supported in this build', async () => {
    const svc = new UsageScalabilityAnalyticsService(sources(1, 0), CLOCK);
    await expect(svc.dashboard(null, '2026-07')).rejects.toThrow(/platform-wide/);
  });
});

const metrics = (over: Partial<ScalabilityMetrics>): ScalabilityMetrics => ({
  tenantId: T, period: '2026-07', turns: 100,
  deterministicHitRate: 0.80, llmCallsPerTurn: 1.0, smallModelShare: 0.6,
  tokensPerTurn: 1500, costPerTurnUsd: 0.01, workerOccupancyInWait: 0.2,
  computedAt: '2026-08-01T00:00:00.000Z' as IsoTimestamp, ...over,
});
const thresholds: ScalabilityThresholds = {
  deterministicHitRateMin: 0.70, maxLlmCallsPerTurn: 1.2, minSmallModelShare: 0.5,
  maxTokensPerTurn: 2500, maxCostPerTurnUsd: 0.02, maxDeterministicHitRateDropPct: 5,
};

describe('ThresholdScalabilityRegressionGate', () => {
  const gate = new ThresholdScalabilityRegressionGate();

  it('passes when the candidate is within all thresholds and no regression vs baseline', () => {
    const r = gate.evaluate(metrics({deterministicHitRate: 0.78}), metrics({deterministicHitRate: 0.80}), thresholds);
    expect(r.pass).toBe(true);
  });

  it('blocks when deterministic_hit_rate drops more than the allowed % vs baseline', () => {
    const r = gate.evaluate(metrics({deterministicHitRate: 0.70}), metrics({deterministicHitRate: 0.80}), thresholds);
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.violations.some(v => v.kpi === 'deterministic_hit_rate')).toBe(true);
  });

  it('blocks when a candidate breaches an absolute threshold (cost/turn too high)', () => {
    const r = gate.evaluate(metrics({costPerTurnUsd: 0.05}), metrics({}), thresholds);
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.violations.map(v => v.kpi)).toContain('cost_per_turn_usd');
  });
});
