// Integration test against the live backing stack (Postgres :5433). Proves the 0013/0014 migrations
// apply and DrizzleHandoffRepository persists an initial handoff request tenant-scoped (RLS 'strict'),
// idempotently (a replayed turn collapses to one row).
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@hermes-one/config';
import type {TenantId} from '@hermes-one/contracts';
import {runMigrations} from './migrate.js';
import {
  createHandoffRepository,
  type HandoffRepositoryHandle,
} from './client.js';
import type {HandoffTaskRow} from './handoff-repository.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const TENANT = 'tnt_handoff_itest' as TenantId;

let owner: Pool;
let handoffs: HandoffRepositoryHandle;

const row: HandoffTaskRow = {
  handoffId: 'hof_itest_1',
  conversationId: 'cnv_handoff_itest',
  triggeringTurnId: 'trn_handoff_itest',
  reason: 'policy-required',
  priority: 'normal',
  summary: 'Customer requires supervisor sign-off for a $3,200 job.',
  evidenceSnapshot: [
    {
      id: 'evd_h1',
      turnId: 'trn_handoff_itest',
      kind: 'authoritative-read',
      statement: 'estimate $3,200',
      data: {estimateUsd: 3200},
      source: 'authoritative',
      trusted: true,
      observedAt: '2026-07-13T00:00:00.000Z',
    },
  ],
  queue: 'supervisors',
  status: 'requested',
  owner: 'agent',
  transitions: [
    {
      from: null,
      to: 'requested',
      by: 'prn_system',
      at: '2026-07-13T00:00:01.000Z',
    },
  ],
  requestedAt: new Date('2026-07-13T00:00:01.000Z'),
};

beforeAll(async () => {
  await runMigrations(PG);
  owner = new Pool({connectionString: PG, max: 2});
  handoffs = createHandoffRepository(PG);
  await owner.query(`DELETE FROM runtime.handoff_tasks WHERE tenant_id = $1`, [
    TENANT,
  ]);
});

afterAll(async () => {
  await owner.query(`DELETE FROM runtime.handoff_tasks WHERE tenant_id = $1`, [
    TENANT,
  ]);
  await owner.end();
  await handoffs.close();
});

describe('DrizzleHandoffRepository.requestHandoff (live)', () => {
  it('persists the initial handoff request tenant-scoped with its grounded snapshot', async () => {
    await handoffs.repo.requestHandoff(row, {tenantId: TENANT});

    const r = await owner.query(
      `SELECT tenant_id, conversation_id, reason, priority, status, owner, queue, summary,
              jsonb_array_length(evidence_snapshot) AS evidence_n,
              jsonb_array_length(transitions) AS transitions_n
         FROM runtime.handoff_tasks WHERE handoff_id = 'hof_itest_1'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]).toMatchObject({
      tenant_id: TENANT,
      conversation_id: 'cnv_handoff_itest',
      reason: 'policy-required',
      priority: 'normal',
      status: 'requested',
      owner: 'agent',
      queue: 'supervisors',
      evidence_n: 1,
      transitions_n: 1,
    });
  });

  it('is idempotent — a replayed handoff request collapses to one row', async () => {
    await handoffs.repo.requestHandoff(row, {tenantId: TENANT});
    const c = await owner.query(
      `SELECT count(*)::int AS n FROM runtime.handoff_tasks WHERE tenant_id = $1`,
      [TENANT],
    );
    expect(c.rows[0].n).toBe(1);
  });
});
