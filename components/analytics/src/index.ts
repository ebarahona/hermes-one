// @hermes-one/analytics — component (edge plane).
// Read-only cost/token analytics over the deduped UsageRecord stream. Cost analytics is live; the scalability KPI dashboard/gate is deferred until its data
// sources exist (deterministic-decision counter, model-call meter, model routing, worker metrics) — see
// docs/DEFERRED-AND-FLAGGED.md.
export {
  UsageCostAnalyticsService,
  type AgentbackMeteringExport,
} from './cost-analytics.js';
export {
  UsageScalabilityAnalyticsService,
  ThresholdScalabilityRegressionGate,
  type ScalabilityDataSources,
} from './scalability-analytics.js';

export const descriptor = {
  name: '@hermes-one/analytics',
  role: 'component',
  plane: 'edge',
  published: false,
  governedBy: ['ADR-009'],
} as const;
