// Integration test against the live backing stack (Postgres :5433). Proves the real composition of the
// scalability dashboard: DrizzleAuditSink.countByAction('decision.rule') + DrizzleUsageMeter
// (summarize + countModelTurns) → UsageScalabilityAnalyticsService.dashboard computes a real
// deterministic-hit-rate from seeded decision.rule events vs model turns.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@hermes-one/config';
import {
  createAuditSink,
  createUsageMeter,
  type AuditSinkHandle,
  type UsageMeterHandle,
} from '@hermes-one/drizzle';
import type {TenantId} from '@hermes-one/contracts';
import {
  UsageScalabilityAnalyticsService,
  type ScalabilityDataSources,
} from './scalability-analytics.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const TENANT = 'tnt_scal_itest' as TenantId;
const PERIOD = '2026-07';

let owner: Pool;
let audit: AuditSinkHandle;
let usage: UsageMeterHandle;

beforeAll(async () => {
  owner = new Pool({connectionString: PG, max: 2});
  audit = createAuditSink(PG);
  usage = createUsageMeter(PG);
  await owner.query(`DELETE FROM audit.audit_events WHERE tenant_id = $1`, [
    TENANT,
  ]);
  await owner.query(`DELETE FROM audit.usage_records WHERE tenant_id = $1`, [
    TENANT,
  ]);

  // 3 deterministic routing decisions (decision.rule), 1 of which escalated to a model turn.
  for (const i of [1, 2, 3]) {
    await owner.query(
      `INSERT INTO audit.audit_events (id, tenant_id, principal_id, action, correlation_id, subject, detail, outcome, occurred_at, integrity_hash)
       VALUES ($1,$2,'prn_system','decision.rule',$3,'pln_rule','{}','success','2026-07-15T00:00:00Z',$4)`,
      [`aud_scal_${i}`, TENANT, `corr_${i}`, `sha256:${'a'.repeat(64)}`],
    );
  }
  // 1 model turn (one model.cost.usd usage row for corr_3).
  await owner.query(
    `INSERT INTO audit.usage_records (dedupe_key, tenant_id, principal_id, meter_kind, quantity, unit, correlation_id, turn_id, period)
     VALUES
       ('dk_s_cost','${TENANT}','prn_x','model.cost.usd',0.01,'usd','corr_3','trn_3','${PERIOD}'),
       ('dk_s_in','${TENANT}','prn_x','model.input.tokens',900,'tokens','corr_3','trn_3','${PERIOD}'),
       ('dk_s_out','${TENANT}','prn_x','model.output.tokens',300,'tokens','corr_3','trn_3','${PERIOD}')`,
  );
});

afterAll(async () => {
  await owner.query(`DELETE FROM audit.audit_events WHERE tenant_id = $1`, [
    TENANT,
  ]);
  await owner.query(`DELETE FROM audit.usage_records WHERE tenant_id = $1`, [
    TENANT,
  ]);
  await owner.end();
  await audit.close();
  await usage.close();
});

describe('UsageScalabilityAnalyticsService (live composition)', () => {
  it('computes the deterministic-hit-rate from real decision.rule events vs model turns', async () => {
    const data: ScalabilityDataSources = {
      summarize: (t, p) => usage.repo.summarize(t, p),
      countRuleDecisions: (t, p) =>
        audit.repo.countByAction(t, 'decision.rule', p),
      countModelTurns: (t, p) => usage.repo.countModelTurns(t, p),
    };
    const svc = new UsageScalabilityAnalyticsService(data);
    const m = await svc.dashboard(TENANT, PERIOD);

    expect(m.turns).toBe(3); // 3 decision.rule events
    expect(m.deterministicHitRate).toBeCloseTo(2 / 3, 6); // (3 - 1 model turn) / 3
    expect(m.tokensPerTurn).toBeCloseTo(1200 / 3, 6); // (900 + 300) / 3
    expect(m.costPerTurnUsd).toBeCloseTo(0.01 / 3, 6); // 0.01 / 3
  });
});
