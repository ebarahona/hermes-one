// Metrics catalogue impls: a Meter accumulates counters + histogram samples
// tagged by dimension. `InMemoryMeter` snapshots for tests / a future /metrics scrape; `LoggingMeter`
// emits each metric event as a structured log line (visible in dev) via the same Logger the platform uses.
// The OTel-backed Meter (real export + histogram aggregation) is the prod swap — deferred (OB5).
import {
  type Logger,
  type LogRecord,
  type MetricName,
  type Meter,
  type SloTarget,
} from '@platform/contracts';

/** Stable key for a metric + its tag set (sorted so tag order doesn't matter). */
function seriesKey(metric: string, tags?: Record<string, string>): string {
  if (!tags || Object.keys(tags).length === 0) return metric;
  const t = Object.keys(tags).sort().map(k => `${k}=${tags[k]}`).join(',');
  return `${metric}{${t}}`;
}

export interface MeterSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, number[]>;
}

export class InMemoryMeter implements Meter {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();

  increment(metric: MetricName, tags?: Record<string, string>, by = 1): void {
    const k = seriesKey(metric, tags);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  record(metric: MetricName, value: number, tags?: Record<string, string>): void {
    const k = seriesKey(metric, tags);
    const arr = this.histograms.get(k) ?? [];
    arr.push(value);
    this.histograms.set(k, arr);
  }

  snapshot(): MeterSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries([...this.histograms].map(([k, v]) => [k, [...v]])),
    };
  }
}

/** Emits each metric event as a structured log record (dev-visible; OTel exporter is the prod swap). */
export class LoggingMeter implements Meter {
  constructor(private readonly logger: Logger, private readonly clock: () => Date = () => new Date()) {}

  private emit(record: Omit<LogRecord, 'level' | 'timestamp' | 'correlation'>): void {
    this.logger.log({level: 'info', timestamp: this.clock().toISOString(), correlation: {}, ...record});
  }

  increment(metric: MetricName, tags?: Record<string, string>, by = 1): void {
    this.emit({message: 'metric.counter', fields: {metric, tags: tags ?? {}, by}});
  }

  record(metric: MetricName, value: number, tags?: Record<string, string>): void {
    this.emit({message: 'metric.histogram', fields: {metric, tags: tags ?? {}, value}});
  }
}

/** The platform SLO catalogue — the ONLY source consulted for alerting (mirrors the contract's example). */
export const DEFAULT_SLO_TARGETS: readonly SloTarget[] = [
  {metric: 'agent.turn.latency_ms', objective: 'p95', targetMs: 8000, windowDays: 7},
  {metric: 'agent.tool.latency_ms', objective: 'p99', targetMs: 3000, windowDays: 7},
  {metric: 'temporal.workflow.task_failure.count', objective: 'errorRate', targetRate: 0.005, windowDays: 1},
];
