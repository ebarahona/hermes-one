// Integration test against the live backing stack (Postgres): two agent-node visits in ONE workflow
// run (same workflow correlationId, same actions/subjects/seq, distinct turnIds) must BOTH persist
// their audit trail. Before the turn-scoped audit id, both visits derived identical ids while their
// integrityHashes (covering turnId + occurredAt) differed, so the append-only sink tamper-rejected the
// second visit's persistTurnAtomic (409 idempotency_conflict, non-retryable) and the run died.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@platform-internal/config';
import type {
  ConversationId,
  IsoTimestamp,
  PrincipalId,
  TenantId,
  ToolCall,
  ToolResult,
  TurnId,
} from '@platform/contracts';
import {
  createTurnPersistence,
  runMigrations,
  type TurnPersistenceBundle,
  type TurnPersistenceHandle,
} from '@platform-internal/drizzle';
import type {TurnLedger} from '@platform-internal/agent-runtime';
import {deriveAuditEvents} from './audit-events.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const TENANT = 'tnt_audit_visit_itest' as TenantId;
const CORRELATION = 'wf-audit-visit-itest';
const AT = '2026-07-22T00:00:05.000Z' as IsoTimestamp;

const call: ToolCall = {
  toolCallId: 'tc_visit_1' as ToolCall['toolCallId'],
  capability: 'appointment.slot.read' as ToolCall['capability'],
  input: {date: '2026-07-23'},
  idempotencyKey: 'idem-visit-1',
  proposedAt: AT,
};
const result: ToolResult = {
  toolCallId: 'tc_visit_1' as ToolResult['toolCallId'],
  capability: 'appointment.slot.read' as ToolResult['capability'],
  ok: true,
  output: {slots: []},
  sideEffect: 'read',
  stateChanged: false,
  changedDomains: ['none'],
  evidence: [],
  metrics: {
    latencyMs: 5,
    providerId: 'p',
    retries: 0,
    costUsd: 0,
    idempotentReplay: false,
  },
  error: null,
};

/** A visit's ledger: same correlationId + material actions for every visit; only the turnId differs. */
const visitLedger = (turnId: string): TurnLedger => ({
  turnId: turnId as TurnId,
  tenantId: TENANT,
  correlationId: CORRELATION,
  toolExecutions: [{call, result}],
  evidence: [],
  usage: {modelCostUsd: 0, inputTokens: 0, outputTokens: 0, toolCount: 1},
  policyDecisions: [],
});

const ctx = {
  principalId: 'prn_visit' as PrincipalId,
  conversationId: null as ConversationId | null,
  occurredAt: AT,
};

// The bundle carries ONLY the derived audit events — the failing insert under the old recipe — so the
// test isolates the audit-id property from the ledger-row idempotency keys.
const bundle = (ledger: TurnLedger): TurnPersistenceBundle => ({
  ledger: {toolExecutions: [], evidence: [], policyDecisions: []},
  auditEvents: deriveAuditEvents(ledger, ctx),
  usageEvents: [],
});

let owner: Pool;
let sut: TurnPersistenceHandle;

const wipe = async () => {
  for (const t of ['audit.audit_events', 'event.event_outbox'])
    await owner.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [TENANT]);
};

beforeAll(async () => {
  await runMigrations(PG);
  owner = new Pool({connectionString: PG, max: 2});
  sut = createTurnPersistence(PG);
  await wipe();
});

afterAll(async () => {
  await wipe();
  await owner.end();
  await sut.close();
});

describe('deriveAuditEvents → persistTurnAtomic across two agent-node visits (live)', () => {
  it('persists BOTH visits — same actions/subjects/seq under distinct turnIds append distinct rows', async () => {
    await sut.repo.persistTurnAtomic(
      bundle(visitLedger(`trn_${CORRELATION}_0`)),
      {tenantId: TENANT},
    );
    // Second visit: identical material actions — previously derived the SAME audit id with a
    // DIFFERENT integrityHash → 409 idempotency_conflict rolled this persist back.
    await sut.repo.persistTurnAtomic(
      bundle(visitLedger(`trn_${CORRELATION}_1`)),
      {tenantId: TENANT},
    );

    const rows = await owner.query(
      `SELECT id, turn_id FROM audit.audit_events WHERE tenant_id = $1 ORDER BY turn_id`,
      [TENANT],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].id).not.toBe(rows.rows[1].id);
    expect(rows.rows.map((r: {turn_id: string}) => r.turn_id)).toEqual([
      `trn_${CORRELATION}_0`,
      `trn_${CORRELATION}_1`,
    ]);
  });

  it('a Temporal retry of the SAME visit re-derives identical rows and collapses idempotently', async () => {
    await sut.repo.persistTurnAtomic(
      bundle(visitLedger(`trn_${CORRELATION}_1`)),
      {tenantId: TENANT},
    );
    const n = await owner.query(
      `SELECT count(*)::int AS n FROM audit.audit_events WHERE tenant_id = $1`,
      [TENANT],
    );
    expect(n.rows[0].n).toBe(2);
  });
});
