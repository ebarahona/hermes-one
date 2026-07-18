// @platform/contracts — src/analytics.ts
// Cost/token analytics + scalability KPI contracts. Transcribed VERBATIM from
// docs/implementation/observability/evaluation-and-cost-analytics.md (the cost + scalability portion).
// CostAnalyticsService is a read-only rollup over the already-deduped UsageRecord stream (T7) —
// summarize() is a pass-through to UsageMeter.summarize() (never a second counter); reconcile() only
// COMPARES against agentback's own metering export and reports drift. The scalability KPIs make the
// three scalability levers (docs/scalability-one-pager.md) measurable — a deterministic-hit-rate drop is
// a scalability bug, not a prose target.
// NOTE: the eval-framework types (GoldenConversationCase/EvaluationRun/RegressionGate) live in the eval
// slice (they need audit-and-replay.md's SimulationService) — transcribed there when built.
import {z} from 'zod';
import {TenantId, IsoTimestamp} from './substrate.js';
import {MeterKind} from './audit.js';

/* -------------------------- Cost / token analytics ------------------------ */

export const ReconciliationReport = z.object({
  tenantId: TenantId,
  period: z.string().regex(/^\d{4}-\d{2}$/),
  status: z.enum(['ok', 'drift']),
  /**
   * Per-meterKind delta between UsageRecord.summarize() and agentback's own export. Empty when 'ok';
   * only drifting meters appear. Keyed by MeterKind via `z.partialRecord` — an enum-keyed record that
   * is NOT exhaustive (the spec's `z.record(MeterKind, …)` would require every key present under Zod v4;
   * `partialRecord` keeps the MeterKind key type while allowing the partial/empty maps this report needs).
   */
  deltas: z.partialRecord(MeterKind, z.object({platformTotal: z.number(), agentbackTotal: z.number(), diffPct: z.number()})),
  toleranceDiffPct: z.number(),
  reconciledAt: IsoTimestamp,
});
export type ReconciliationReport = z.infer<typeof ReconciliationReport>;

export interface CostAnalyticsService {
  /** Thin pass-through to UsageMeter.summarize() (audit-contracts.md) — no independent aggregation. */
  summarize(tenantId: TenantId, period: string): Promise<Record<MeterKind, number>>;
  /** Read-only drift check against agentback's own metering export. Never writes/corrects UsageRecord. */
  reconcile(tenantId: TenantId, period: string): Promise<ReconciliationReport>;
}

/* ---------------------- Scalability KPIs (dashboards + gates) -------------- */
// Sourced read-only from the deduped UsageRecord/metering stream + turn counters; worker-occupancy-in-wait
// from Temporal/OTel metrics (tracing-metrics-logging.md). None is a datastore metric.

export const ScalabilityKpi = z.enum([
  'deterministic_hit_rate',   // fraction of decisions resolved with ZERO LLM call — the load-shed lever
  'llm_calls_per_turn',       // model calls / turns that called the model — the right-size lever
  'small_model_share',        // small-model calls / total model calls
  'tokens_per_turn',          // total model tokens / turns
  'cost_per_turn_usd',        // total model cost / turns — unit economics
  'worker_occupancy_in_wait', // activity-slot occupancy attributable to waiting conversations — the non-blocking lever
]);
export type ScalabilityKpi = z.infer<typeof ScalabilityKpi>;

export const ScalabilityMetrics = z.object({
  tenantId: TenantId.nullable(),     // null = platform-wide rollup
  period: z.string(),                // '2026-07' for the live dashboard, or a DeploymentRef id for an eval run
  turns: z.number().int().nonnegative(),
  deterministicHitRate: z.number().min(0).max(1),
  llmCallsPerTurn: z.number().min(0),
  smallModelShare: z.number().min(0).max(1),
  tokensPerTurn: z.number().min(0),
  costPerTurnUsd: z.number().min(0),
  workerOccupancyInWait: z.number().min(0).max(1),
  computedAt: IsoTimestamp,
});
export type ScalabilityMetrics = z.infer<typeof ScalabilityMetrics>;

export interface ScalabilityAnalyticsService {
  /** Production dashboard: computes the KPIs over UsageRecord + turn counts for a period. Read-only. */
  dashboard(tenantId: TenantId | null, period: string): Promise<ScalabilityMetrics>;
}

/** Per-KPI targets + max allowed regression vs the baseline deployment. Defaults mirror the one-pager. */
export const ScalabilityThresholds = z.object({
  deterministicHitRateMin: z.number().min(0).max(1).default(0.70),
  maxLlmCallsPerTurn: z.number().min(0).default(1.2),
  minSmallModelShare: z.number().min(0).max(1).default(0.5),
  maxTokensPerTurn: z.number().min(0).default(2500),
  maxCostPerTurnUsd: z.number().min(0).default(0.02),
  maxDeterministicHitRateDropPct: z.number().min(0).default(5), // candidate vs baseline deployment
});
export type ScalabilityThresholds = z.infer<typeof ScalabilityThresholds>;

export interface ScalabilityRegressionGate {
  /** Compares a candidate deployment's eval-run KPIs to the baseline deployment's KPIs against the
   *  thresholds. Consulted alongside RegressionGate at publish (behavior gate + scalability gate). */
  evaluate(
    candidate: ScalabilityMetrics,
    baseline: ScalabilityMetrics,
    thresholds: ScalabilityThresholds,
  ): {pass: true} | {pass: false; reason: string; violations: Array<{kpi: ScalabilityKpi; value: number; limit: number}>};
}
