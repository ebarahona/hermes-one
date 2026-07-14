// Integration test against the live backing stack (Postgres :5433). Proves the real composition:
// UsageCostAnalyticsService over a real DrizzleUsageMeter reading real audit.usage_records —
// summarize() passes the deduped totals through, reconcile() reports ok/drift against an injected
// agentback export.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@platform-internal/config';
import {createUsageMeter, type UsageMeterHandle} from '@platform-internal/drizzle';
import type {MeterKind, TenantId} from '@platform/contracts';
import {UsageCostAnalyticsService} from './cost-analytics.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const TENANT = 'tnt_cost_itest' as TenantId;
const PERIOD = '2026-07';

let owner: Pool;
let meter: UsageMeterHandle;

beforeAll(async () => {
  owner = new Pool({connectionString: PG, max: 2});
  meter = createUsageMeter(PG);
  await owner.query(`DELETE FROM audit.usage_records WHERE tenant_id = $1`, [TENANT]);
  // Seed deduped usage rows (owner bypasses RLS).
  await owner.query(
    `INSERT INTO audit.usage_records (dedupe_key, tenant_id, principal_id, meter_kind, quantity, unit, correlation_id, turn_id, period)
     VALUES
       ('dk_in','${TENANT}','prn_x','model.input.tokens',1000,'tokens','trn_x','trn_x','${PERIOD}'),
       ('dk_out','${TENANT}','prn_x','model.output.tokens',400,'tokens','trn_x','trn_x','${PERIOD}'),
       ('dk_cost','${TENANT}','prn_x','model.cost.usd',0.02,'usd','trn_x','trn_x','${PERIOD}')`,
  );
});

afterAll(async () => {
  await owner.query(`DELETE FROM audit.usage_records WHERE tenant_id = $1`, [TENANT]);
  await owner.end();
  await meter.close();
});

describe('UsageCostAnalyticsService (live)', () => {
  it('summarize passes the deduped UsageRecord totals through', async () => {
    const svc = new UsageCostAnalyticsService(meter.repo, async () => ({}));
    const s = await svc.summarize(TENANT, PERIOD);
    expect(s['model.input.tokens']).toBe(1000);
    expect(s['model.output.tokens']).toBe(400);
    expect(s['model.cost.usd']).toBeCloseTo(0.02, 6);
  });

  it('reconcile reports ok when agentback matches the platform totals', async () => {
    const svc = new UsageCostAnalyticsService(
      meter.repo,
      async () => ({'model.input.tokens': 1000, 'model.output.tokens': 400, 'model.cost.usd': 0.02}) as Partial<Record<MeterKind, number>>,
      {toleranceDiffPct: 1},
    );
    const r = await svc.reconcile(TENANT, PERIOD);
    expect(r.status).toBe('ok');
    expect(r.deltas).toEqual({});
  });

  it('reconcile reports drift when agentback disagrees beyond tolerance', async () => {
    const svc = new UsageCostAnalyticsService(
      meter.repo,
      async () => ({'model.input.tokens': 1000, 'model.output.tokens': 400, 'model.cost.usd': 0.03}) as Partial<Record<MeterKind, number>>,
      {toleranceDiffPct: 1},
    );
    const r = await svc.reconcile(TENANT, PERIOD);
    expect(r.status).toBe('drift');
    expect(Object.keys(r.deltas)).toEqual(['model.cost.usd']); // 0.02 vs 0.03 → ~-33%
    expect(r.deltas['model.cost.usd']!.diffPct).toBeLessThan(-30);
  });
});
