// Integration test against the live backing stack (Postgres :5433). Proves DrizzleAuditQueryService
// composes an incident timeline by joining audit_events ⋈ tool_executions ⋈ policy_decisions ⋈
// evidence_records for a (tenant, correlationId) — audit/policy by correlation_id, tool/evidence bridged
// via the correlation's turnIds — tenant-scoped (RLS), sorted by occurredAt.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@platform-internal/config';
import {
  createAuditQueryService,
  type AuditQueryServiceHandle,
} from './client.js';
import type {TenantId} from '@platform/contracts';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const TENANT = 'tnt_tl_itest' as TenantId;
const CID = 'corr_tl';
const TURN = 'trn_tl';
const HASH = `sha256:${'a'.repeat(64)}`;

let owner: Pool;
let q: AuditQueryServiceHandle;

beforeAll(async () => {
  owner = new Pool({connectionString: PG, max: 2});
  q = createAuditQueryService(PG);
  for (const t of ['audit_events'] as const)
    await owner.query(`DELETE FROM audit.${t} WHERE tenant_id=$1`, [TENANT]);
  for (const t of [
    'tool_executions',
    'evidence_records',
    'policy_decisions',
  ] as const)
    await owner.query(`DELETE FROM runtime.${t} WHERE tenant_id=$1`, [TENANT]);

  // A rule decision (workflow-level, turn_id NULL) + a turn's tool.invoked audit (turn-linked).
  await owner.query(
    `INSERT INTO audit.audit_events (id, tenant_id, principal_id, action, correlation_id, turn_id, subject, detail, outcome, occurred_at, integrity_hash) VALUES
       ('aud_tl_rule','${TENANT}','prn_system','decision.rule','${CID}',NULL,'pln_rule','{}','success','2026-07-20T00:00:00Z','${HASH}'),
       ('aud_tl_tool','${TENANT}','prn_x','tool.invoked','${CID}','${TURN}','appointment.slot.read','{}','success','2026-07-20T00:00:02.5Z','${HASH}')`,
  );
  await owner.query(
    `INSERT INTO runtime.policy_decisions (decision_id, tenant_id, turn_id, correlation_id, site, policy_rule_id, outcome, reason, decided_at) VALUES
       ('pld_tl','${TENANT}','${TURN}','${CID}','preGate','<default>','allow','ok','2026-07-20T00:00:01Z')`,
  );
  await owner.query(
    `INSERT INTO runtime.tool_executions (tool_call_id, tenant_id, turn_id, capability_name, input, idempotency_key, ok, output, side_effect, state_changed, changed_domains, metrics, proposed_at, executed_at) VALUES
       ('tc_tl','${TENANT}','${TURN}','appointment.slot.read','{}','idem_tl',true,'{"slots":[]}','read',false,'{none}',
        '{"latencyMs":5,"providerId":"p","retries":0,"costUsd":0,"idempotentReplay":false}','2026-07-20T00:00:02Z','2026-07-20T00:00:02Z')`,
  );
  await owner.query(
    `INSERT INTO runtime.evidence_records (id, tenant_id, turn_id, tool_call_id, kind, capability_name, statement, data, source, trusted, observed_at) VALUES
       ('evd_tl','${TENANT}','${TURN}','tc_tl','tool-output','appointment.slot.read','no slots','{}','provider',false,'2026-07-20T00:00:03Z')`,
  );
});

afterAll(async () => {
  await owner.query(`DELETE FROM audit.audit_events WHERE tenant_id=$1`, [
    TENANT,
  ]);
  for (const t of [
    'tool_executions',
    'evidence_records',
    'policy_decisions',
  ] as const)
    await owner.query(`DELETE FROM runtime.${t} WHERE tenant_id=$1`, [TENANT]);
  await owner.end();
  await q.close();
});

describe('DrizzleAuditQueryService.composeTimeline (live)', () => {
  it('joins all four sources for the correlation, sorted by occurredAt', async () => {
    const tl = await q.repo.composeTimeline(TENANT, CID);
    expect(tl.map(e => e.kind)).toEqual([
      'audit', // decision.rule @ 00:00:00
      'policy-decision', // @ 00:00:01
      'tool-execution', // @ 00:00:02
      'audit', // tool.invoked @ 00:00:02.5
      'evidence', // @ 00:00:03
    ]);
    expect(tl.every(e => e.detail !== null)).toBe(true);
    // tool/evidence were bridged via the turnId even though they carry no correlation_id.
    const tool = tl.find(e => e.kind === 'tool-execution');
    expect((tool!.detail as {toolCallId: string}).toolCallId).toBe('tc_tl');
  });

  it('queryAuditEvents filters by action (compliance export)', async () => {
    const events = await q.repo.queryAuditEvents(TENANT, {
      action: 'decision.rule',
    });
    expect(events.map(e => e.id)).toEqual(['aud_tl_rule']);
  });

  it('returns an empty timeline for an unknown correlation (tenant-scoped)', async () => {
    expect(await q.repo.composeTimeline(TENANT, 'corr_nope')).toEqual([]);
  });
});
