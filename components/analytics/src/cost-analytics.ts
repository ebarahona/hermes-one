// CostAnalyticsService (edge plane): a READ-ONLY rollup over the already-deduped UsageRecord stream.
// `summarize` is a thin pass-through to UsageMeter.summarize() — the platform never
// runs a second counter (T7). `reconcile` COMPARES the platform totals against agentback's own metering
// export and reports per-meter drift; it never writes back or corrects UsageRecord.
//
// FLAGGED: agentback's metering export is not wired in this build — the composition root injects an
// `agentbackExport` function; a stub that mirrors the platform totals yields status 'ok'. The real export
// integration (T7 reconciliation) is the follow-up.
import {
  ReconciliationReport,
  type CostAnalyticsService,
  type IsoTimestamp,
  type MeterKind,
  type TenantId,
  type UsageMeter,
} from '@platform/contracts';

/** Pulls agentback's own metering totals for (tenant, period) — the reconcile comparison source. */
export type AgentbackMeteringExport = (
  tenantId: TenantId,
  period: string,
) => Promise<Partial<Record<MeterKind, number>>>;

const ALL_METER_KINDS: MeterKind[] = [
  'model.input.tokens', 'model.output.tokens', 'model.cost.usd', 'tool.invocation', 'message.sent', 'storage.vector',
];

export class UsageCostAnalyticsService implements CostAnalyticsService {
  constructor(
    private readonly meter: UsageMeter,
    private readonly agentbackExport: AgentbackMeteringExport,
    private readonly opts: {toleranceDiffPct?: number; clock?: () => Date} = {},
  ) {}

  /** No independent aggregation — the deduped UsageRecord table is the single source (T7). */
  async summarize(tenantId: TenantId, period: string): Promise<Record<MeterKind, number>> {
    return this.meter.summarize(tenantId, period);
  }

  async reconcile(tenantId: TenantId, period: string): Promise<ReconciliationReport> {
    const tolerance = this.opts.toleranceDiffPct ?? 1; // percent
    const now = (this.opts.clock ?? (() => new Date()))().toISOString() as IsoTimestamp;
    const platform = await this.meter.summarize(tenantId, period);
    const agentback = await this.agentbackExport(tenantId, period);

    const deltas: Record<string, {platformTotal: number; agentbackTotal: number; diffPct: number}> = {};
    for (const kind of ALL_METER_KINDS) {
      const p = platform[kind] ?? 0;
      const a = agentback[kind] ?? 0;
      if (p === 0 && a === 0) continue;
      const diffPct = a === 0 ? 100 : ((p - a) / a) * 100;
      if (Math.abs(diffPct) > tolerance) {
        deltas[kind] = {platformTotal: p, agentbackTotal: a, diffPct};
      }
    }

    return ReconciliationReport.parse({
      tenantId,
      period,
      status: Object.keys(deltas).length === 0 ? 'ok' : 'drift',
      deltas,
      toleranceDiffPct: tolerance,
      reconciledAt: now,
    });
  }
}
