// Integration test against the live backing stack (Postgres :5433). Proves Tier 2 durable turn
// persistence: the 0011/0012 migrations apply, and DrizzleTurnLedgerRepository persists a completed
// turn's tool executions, evidence, and policy decisions tenant-scoped (RLS 'strict') in one
// transaction, idempotently (a replayed turn collapses to the same rows).
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@hermes-one/config';
import type {TenantId} from '@hermes-one/contracts';
import {runMigrations} from './migrate.js';
import {
  createTurnLedgerRepository,
  type TurnLedgerRepositoryHandle,
} from './client.js';
import type {TurnLedgerRows} from './turn-ledger-repository.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const TENANT = 'tnt_ledger_itest' as TenantId;
const TURN = 'trn_ledger_itest';

let owner: Pool;
let ledger: TurnLedgerRepositoryHandle;

const bundle: TurnLedgerRows = {
  toolExecutions: [
    {
      toolCallId: 'tc_ledger_1',
      turnId: TURN,
      capabilityName: 'appointment.slot.read',
      input: {date: '2026-07-14'},
      idempotencyKey: 'idem-ledger-1',
      ok: true,
      output: {slots: ['09:00', '11:00']},
      sideEffect: 'read',
      stateChanged: false,
      changedDomains: ['none'],
      metrics: {
        latencyMs: 12,
        providerId: 'appt-provider',
        retries: 0,
        costUsd: 0,
        idempotentReplay: false,
      },
      proposedAt: new Date('2026-07-13T00:00:00.000Z'),
    },
  ],
  evidence: [
    {
      id: 'evd_ledger_1',
      turnId: TURN,
      toolCallId: 'tc_ledger_1',
      kind: 'tool-output',
      capabilityName: 'appointment.slot.read',
      statement: 'slots available at 09:00 and 11:00',
      data: {slots: ['09:00', '11:00']},
      source: 'provider',
      trusted: false,
      observedAt: new Date('2026-07-13T00:00:01.000Z'),
    },
  ],
  policyDecisions: [
    {
      decisionId: 'pld_ledger_pre',
      turnId: TURN,
      correlationId: TURN,
      site: 'preGate',
      policyRuleId: '<default>',
      outcome: 'allow',
      reason: 'ok',
      decidedAt: new Date('2026-07-13T00:00:00.500Z'),
    },
    {
      decisionId: 'pld_ledger_post',
      turnId: TURN,
      correlationId: TURN,
      site: 'postGate',
      policyRuleId: '<default>',
      outcome: 'allow',
      reason: 'ok',
      decidedAt: new Date('2026-07-13T00:00:02.000Z'),
    },
  ],
};

const countFor = async (table: string): Promise<number> => {
  const r = await owner.query(
    `SELECT count(*)::int AS n FROM runtime.${table} WHERE tenant_id = $1`,
    [TENANT],
  );
  return r.rows[0].n as number;
};

beforeAll(async () => {
  await runMigrations(PG);
  owner = new Pool({connectionString: PG, max: 2});
  ledger = createTurnLedgerRepository(PG);
  for (const t of ['tool_executions', 'evidence_records', 'policy_decisions']) {
    await owner.query(`DELETE FROM runtime.${t} WHERE tenant_id = $1`, [
      TENANT,
    ]);
  }
});

afterAll(async () => {
  for (const t of ['tool_executions', 'evidence_records', 'policy_decisions']) {
    await owner.query(`DELETE FROM runtime.${t} WHERE tenant_id = $1`, [
      TENANT,
    ]);
  }
  await owner.end();
  await ledger.close();
});

describe('DrizzleTurnLedgerRepository.persistTurn (live)', () => {
  it('persists tool executions, evidence, and policy decisions tenant-scoped in one transaction', async () => {
    await ledger.repo.persistTurn(bundle, {tenantId: TENANT});

    expect(await countFor('tool_executions')).toBe(1);
    expect(await countFor('evidence_records')).toBe(1);
    expect(await countFor('policy_decisions')).toBe(2);

    // Spot-check the tool-execution envelope + tenant column (the RLS predicate).
    const te = await owner.query(
      `SELECT tenant_id, capability_name, ok, side_effect, changed_domains, idempotency_key
         FROM runtime.tool_executions WHERE tool_call_id = 'tc_ledger_1'`,
    );
    expect(te.rows[0]).toMatchObject({
      tenant_id: TENANT,
      capability_name: 'appointment.slot.read',
      ok: true,
      side_effect: 'read',
      changed_domains: ['none'],
      idempotency_key: 'idem-ledger-1',
    });

    // Both gate sites recorded.
    const sites = await owner.query(
      `SELECT site FROM runtime.policy_decisions WHERE tenant_id = $1 ORDER BY decided_at`,
      [TENANT],
    );
    expect(sites.rows.map(r => r.site)).toEqual(['preGate', 'postGate']);
  });

  it('is idempotent — a replayed turn collapses to the same rows', async () => {
    await ledger.repo.persistTurn(bundle, {tenantId: TENANT});
    expect(await countFor('tool_executions')).toBe(1);
    expect(await countFor('evidence_records')).toBe(1);
    expect(await countFor('policy_decisions')).toBe(2);
  });

  it('collapses a retried tool call with a NEW tool_call_id but the SAME idempotency key (no 23505)', async () => {
    // Regression: the (tenant_id, idempotency_key) unique index must be swallowed by ON CONFLICT DO
    // NOTHING, not just the tool_call_id PK — else a Temporal retry throws and hangs the activity.
    const retried: TurnLedgerRows = {
      ...bundle,
      toolExecutions: [
        {...bundle.toolExecutions[0], toolCallId: 'tc_ledger_1_retry'},
      ],
      evidence: [],
      policyDecisions: [],
    };
    await expect(
      ledger.repo.persistTurn(retried, {tenantId: TENANT}),
    ).resolves.toBeUndefined();
    expect(await countFor('tool_executions')).toBe(1); // same idempotency key → still one row
  });
});
