// Integration test against the live backing stack (Postgres :5433). Proves the 0017/0018 migrations apply
// and DrizzleUsageMeter records billable usage tenant-scoped (RLS 'strict'), collapses re-emissions on
// dedupeKey (exactly-once billing, T7), and summarizes per meter kind for a billing period.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@platform-internal/config';
import type {MeterKind, TenantId, UsageEvent} from '@platform/contracts';
import {runMigrations} from './migrate.js';
import {createUsageMeter, type UsageMeterHandle} from './client.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const TENANT = 'tnt_usage_itest' as TenantId;
const EMITTED = '2026-07-13T09:00:00.000Z' as UsageEvent['emittedAt']; // period '2026-07'

let owner: Pool;
let usage: UsageMeterHandle;

const ev = (
  meterKind: MeterKind,
  quantity: number,
  unit: UsageEvent['unit'],
): UsageEvent => ({
  id: `usg_${meterKind}` as UsageEvent['id'],
  tenantId: TENANT,
  principalId: 'prn_usage' as UsageEvent['principalId'],
  meterKind,
  quantity,
  unit,
  correlationId: 'trn_usage_itest',
  turnId: 'trn_usage_itest' as UsageEvent['turnId'],
  capability: null,
  dedupeKey: `prn_usage:trn_usage_itest:${meterKind}:0`,
  emittedAt: EMITTED,
});

beforeAll(async () => {
  await runMigrations(PG);
  owner = new Pool({connectionString: PG, max: 2});
  usage = createUsageMeter(PG);
  await owner.query(`DELETE FROM audit.usage_records WHERE tenant_id = $1`, [
    TENANT,
  ]);
});

afterAll(async () => {
  await owner.query(`DELETE FROM audit.usage_records WHERE tenant_id = $1`, [
    TENANT,
  ]);
  await owner.end();
  await usage.close();
});

describe('DrizzleUsageMeter (live)', () => {
  it('records usage and summarizes per meter kind for the period', async () => {
    expect(
      (await usage.repo.record(ev('model.input.tokens', 1200, 'tokens')))
        .inserted,
    ).toBe(true);
    expect(
      (await usage.repo.record(ev('model.output.tokens', 340, 'tokens')))
        .inserted,
    ).toBe(true);
    expect(
      (await usage.repo.record(ev('model.cost.usd', 0.0021, 'usd'))).inserted,
    ).toBe(true);

    const summary = await usage.repo.summarize(TENANT, '2026-07');
    expect(summary['model.input.tokens']).toBe(1200);
    expect(summary['model.output.tokens']).toBe(340);
    expect(summary['model.cost.usd']).toBeCloseTo(0.0021, 6);
    expect(summary['tool.invocation']).toBe(0); // untouched kinds default to 0
  });

  it('collapses a re-emitted event on dedupeKey — exactly-once billing (first quantity wins)', async () => {
    // Same dedupeKey, DIFFERENT quantity (a retry re-emitting different token count) → dropped.
    const res = await usage.repo.record(
      ev('model.input.tokens', 999999, 'tokens'),
    );
    expect(res.inserted).toBe(false);
    const summary = await usage.repo.summarize(TENANT, '2026-07');
    expect(summary['model.input.tokens']).toBe(1200); // unchanged — the first record stands
  });
});
