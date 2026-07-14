// Derive the platform metrics catalogue (tracing-metrics-logging.md) from a completed turn's ledger +
// wall latency — an edge concern (the agent plane produces the data; the edge records the metrics).
// TURN_COUNT/latency, per-tool invocation count + latency, per-gate decision count — the SLO signals
// (turn p95, tool p99, error rates) that audit/usage rows don't carry.
import {MetricName, type Meter} from '@platform/contracts';
import type {TurnLedger} from '@platform-internal/agent-runtime';

export function emitTurnMetrics(
  meter: Meter,
  ledger: TurnLedger,
  outcome: string,
  turnLatencyMs: number,
): void {
  meter.increment(MetricName.TURN_COUNT, {tenantId: ledger.tenantId, outcome});
  meter.record(MetricName.TURN_LATENCY_MS, turnLatencyMs, {tenantId: ledger.tenantId});

  for (const {result} of ledger.toolExecutions) {
    meter.increment(MetricName.TOOL_INVOCATION_COUNT, {capability: result.capability, ok: String(result.ok)});
    meter.record(MetricName.TOOL_LATENCY_MS, result.metrics.latencyMs, {capability: result.capability});
  }

  for (const d of ledger.policyDecisions) {
    meter.increment(MetricName.GATE_DECISION_COUNT, {site: d.site, outcome: d.decision.outcome});
  }
}
