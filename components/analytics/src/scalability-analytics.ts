// ScalabilityAnalyticsService + ScalabilityRegressionGate (edge plane) — the scalability one-pager's KPIs
// made measurable. Sourced READ-ONLY from the deduped metering stream + decision counters (no datastore
// metric). The dashboard depends on injected, tenant-scoped data functions (the edge composition wires the
// Drizzle audit/usage repos) so this component stays store-free.
//
// LIVE KPIs (real data today): deterministic_hit_rate (decision.rule audit events vs model turns),
// tokens_per_turn, cost_per_turn_usd (usage_records amortized over all decisions).
// PENDING KPIs (return 0, FLAGGED — DEFERRED-AND-FLAGGED OB1): llm_calls_per_turn (needs a per-turn
// model-call meter), small_model_share (needs model routing), worker_occupancy_in_wait (needs OTel worker
// metrics). Until instrumented, do NOT gate on the pending KPIs (configure permissive thresholds).
import {
  ScalabilityMetrics,
  type IsoTimestamp,
  type MeterKind,
  type ScalabilityAnalyticsService,
  type ScalabilityKpi,
  type ScalabilityMetrics as ScalabilityMetricsType,
  type ScalabilityRegressionGate,
  type ScalabilityThresholds,
  type TenantId,
} from '@platform/contracts';

export interface ScalabilityDataSources {
  /** Per-meter totals for the period (UsageMeter.summarize). */
  summarize(
    tenantId: TenantId,
    period: string,
  ): Promise<Record<MeterKind, number>>;
  /** Count of ALL routing decisions made by the deterministic rail — audit_events action='decision.rule'
   *  (one per inbound). The KPI denominator; the subset that stayed deterministic = this − model turns. */
  countRuleDecisions(tenantId: TenantId, period: string): Promise<number>;
  /** Count of distinct turns that called the model — usage_records model.cost.usd rows (the escalations). */
  countModelTurns(tenantId: TenantId, period: string): Promise<number>;
}

export class UsageScalabilityAnalyticsService implements ScalabilityAnalyticsService {
  constructor(
    private readonly data: ScalabilityDataSources,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async dashboard(
    tenantId: TenantId | null,
    period: string,
  ): Promise<ScalabilityMetricsType> {
    if (tenantId === null) {
      // Cross-tenant aggregation would require a privileged (RLS-bypassing) aggregator — not wired.
      throw new Error(
        'platform-wide scalability rollup (tenantId=null) is not supported in this build',
      );
    }
    const [totals, decisions, modelTurns] = await Promise.all([
      this.data.summarize(tenantId, period),
      this.data.countRuleDecisions(tenantId, period),
      this.data.countModelTurns(tenantId, period),
    ]);
    // Each inbound is one routing decision (decision.rule). The ones that stayed deterministic = decisions
    // that did NOT escalate to a model turn. ASSUMES one rule decision gates each model turn (true for the
    // current single-turn workflows) — multi-turn conversations need per-conversation counting (flagged).
    const turns = decisions; // total routing decisions = total work units
    const deterministicHits = Math.max(0, decisions - modelTurns);
    const tokens =
      (totals['model.input.tokens'] ?? 0) +
      (totals['model.output.tokens'] ?? 0);
    const cost = totals['model.cost.usd'] ?? 0;
    const per = (n: number) => (turns === 0 ? 0 : n / turns);

    return ScalabilityMetrics.parse({
      tenantId,
      period,
      turns,
      deterministicHitRate: turns === 0 ? 0 : deterministicHits / turns,
      tokensPerTurn: per(tokens),
      costPerTurnUsd: per(cost),
      // PENDING — no data source yet (flagged, OB1). Zero, not fabricated.
      llmCallsPerTurn: 0,
      smallModelShare: 0,
      workerOccupancyInWait: 0,
      computedAt: this.clock().toISOString() as IsoTimestamp,
    });
  }
}

/** Pure candidate-vs-baseline threshold gate (no I/O). Consulted at deployment publish alongside the
 *  behavioral RegressionGate. Blocks on any threshold breach or a deterministic-hit-rate drop > tolerance. */
export class ThresholdScalabilityRegressionGate implements ScalabilityRegressionGate {
  evaluate(
    candidate: ScalabilityMetricsType,
    baseline: ScalabilityMetricsType,
    thresholds: ScalabilityThresholds,
  ):
    | {pass: true}
    | {
        pass: false;
        reason: string;
        violations: Array<{kpi: ScalabilityKpi; value: number; limit: number}>;
      } {
    const violations: Array<{
      kpi: ScalabilityKpi;
      value: number;
      limit: number;
    }> = [];

    if (candidate.deterministicHitRate < thresholds.deterministicHitRateMin) {
      violations.push({
        kpi: 'deterministic_hit_rate',
        value: candidate.deterministicHitRate,
        limit: thresholds.deterministicHitRateMin,
      });
    }
    // Relative regression vs the baseline deployment.
    const dropPct =
      baseline.deterministicHitRate > 0
        ? ((baseline.deterministicHitRate - candidate.deterministicHitRate) /
            baseline.deterministicHitRate) *
          100
        : 0;
    if (dropPct > thresholds.maxDeterministicHitRateDropPct) {
      const limit =
        baseline.deterministicHitRate *
        (1 - thresholds.maxDeterministicHitRateDropPct / 100);
      violations.push({
        kpi: 'deterministic_hit_rate',
        value: candidate.deterministicHitRate,
        limit,
      });
    }
    if (candidate.llmCallsPerTurn > thresholds.maxLlmCallsPerTurn) {
      violations.push({
        kpi: 'llm_calls_per_turn',
        value: candidate.llmCallsPerTurn,
        limit: thresholds.maxLlmCallsPerTurn,
      });
    }
    if (candidate.smallModelShare < thresholds.minSmallModelShare) {
      violations.push({
        kpi: 'small_model_share',
        value: candidate.smallModelShare,
        limit: thresholds.minSmallModelShare,
      });
    }
    if (candidate.tokensPerTurn > thresholds.maxTokensPerTurn) {
      violations.push({
        kpi: 'tokens_per_turn',
        value: candidate.tokensPerTurn,
        limit: thresholds.maxTokensPerTurn,
      });
    }
    if (candidate.costPerTurnUsd > thresholds.maxCostPerTurnUsd) {
      violations.push({
        kpi: 'cost_per_turn_usd',
        value: candidate.costPerTurnUsd,
        limit: thresholds.maxCostPerTurnUsd,
      });
    }

    if (violations.length === 0) return {pass: true};
    return {
      pass: false,
      reason: `scalability regression: ${violations.map(v => v.kpi).join(', ')}`,
      violations,
    };
  }
}
