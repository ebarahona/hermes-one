// Integration test against the live backing stack (Postgres :5433). Proves the F3 atomic turn
// persistence: ONE tenant-scoped transaction commits ledger + handoff + audit + usage + the
// commit-and-publish event_outbox rows — all or nothing (a poisoned batch rolls everything back),
// idempotently (a Temporal activity replay collapses to the same rows).
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@platform-internal/config';
import type {AuditEvent, TenantId, UsageEvent} from '@platform/contracts';
import {runMigrations} from './migrate.js';
import {createTurnPersistence, type TurnPersistenceHandle} from './client.js';
import type {TurnPersistenceBundle} from './turn-persistence.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const TENANT = 'tnt_atomic_itest' as TenantId;
const TURN = 'trn_atomic_itest';
const AT = '2026-07-13T00:00:05.000Z';

let owner: Pool;
let sut: TurnPersistenceHandle;

const auditEvent = (id: string, action: AuditEvent['action']): AuditEvent =>
  ({
    id,
    tenantId: TENANT,
    principalId: 'prn_atomic',
    action,
    correlationId: TURN,
    turnId: TURN,
    conversationId: null,
    subject: 'appointment.slot.read',
    detail: {ok: true},
    outcome: 'success',
    occurredAt: AT,
    integrityHash: `sha256:${'e'.repeat(64)}`,
  }) as unknown as AuditEvent;

const usageEvent: UsageEvent = {
  dedupeKey: `prn_atomic:${TURN}:tool.invocation:0`,
  tenantId: TENANT,
  principalId: 'prn_atomic',
  meterKind: 'tool.invocation',
  quantity: 1,
  unit: 'count',
  correlationId: TURN,
  turnId: TURN,
  emittedAt: AT,
} as unknown as UsageEvent;

const bundle = (): TurnPersistenceBundle => ({
  ledger: {
    toolExecutions: [
      {
        toolCallId: 'tc_atomic_1',
        turnId: TURN,
        capabilityName: 'appointment.slot.read',
        input: {date: '2026-07-14'},
        idempotencyKey: 'idem-atomic-1',
        ok: true,
        output: {slots: ['09:00']},
        sideEffect: 'read',
        stateChanged: false,
        changedDomains: ['none'],
        metrics: {latencyMs: 9, providerId: 'appt-provider', retries: 0, costUsd: 0, idempotentReplay: false},
        proposedAt: new Date(AT),
      },
    ],
    evidence: [],
    policyDecisions: [
      {
        decisionId: 'pld_atomic_pre',
        turnId: TURN,
        correlationId: TURN,
        site: 'preGate',
        policyRuleId: '<default>',
        outcome: 'allow',
        reason: 'ok',
        decidedAt: new Date(AT),
      },
    ],
  },
  handoff: {
    handoffId: 'hof_atomic_1',
    conversationId: 'cnv_atomic',
    triggeringTurnId: TURN,
    reason: 'agent-uncertain',
    priority: 'normal',
    summary: 'needs a human',
    evidenceSnapshot: [],
    queue: 'general',
    status: 'requested',
    owner: 'agent',
    transitions: [{from: null, to: 'requested', by: 'prn_system', at: AT}],
    requestedAt: new Date(AT),
    updatedAt: new Date(AT),
  },
  auditEvents: [auditEvent('aud_atomic_1', 'tool.invoked'), auditEvent('aud_atomic_2', 'decision.policy')],
  usageEvents: [usageEvent],
});

const count = async (schemaTable: string): Promise<number> => {
  const r = await owner.query(`SELECT count(*)::int AS n FROM ${schemaTable} WHERE tenant_id = $1`, [TENANT]);
  return r.rows[0].n as number;
};
const TABLES = [
  'runtime.tool_executions',
  'runtime.policy_decisions',
  'runtime.handoff_tasks',
  'audit.audit_events',
  'audit.usage_records',
  'event.event_outbox',
];

const wipe = async () => {
  // audit_events is append-only for platform_app; the owner (table owner) may clean test residue.
  for (const t of TABLES) await owner.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [TENANT]);
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

describe('DrizzleTurnPersistence.persistTurnAtomic (live, F3)', () => {
  it('commits ledger + handoff + audit + usage + outbox rows in ONE transaction', async () => {
    await sut.repo.persistTurnAtomic(bundle(), {tenantId: TENANT});

    expect(await count('runtime.tool_executions')).toBe(1);
    expect(await count('runtime.policy_decisions')).toBe(1);
    expect(await count('runtime.handoff_tasks')).toBe(1);
    expect(await count('audit.audit_events')).toBe(2);
    expect(await count('audit.usage_records')).toBe(1);

    // Commit-and-publish: one pending outbox row per audit event, deterministic id, payload = the event.
    const obx = await owner.query(
      `SELECT outbox_id, aggregate_type, aggregate_id, event_type, status, payload->>'action' AS action
         FROM event.event_outbox WHERE tenant_id = $1 ORDER BY outbox_id`,
      [TENANT],
    );
    expect(obx.rows).toHaveLength(2);
    expect(obx.rows[0]).toMatchObject({
      outbox_id: 'obx_atomic_1', aggregate_type: 'audit_event', aggregate_id: 'aud_atomic_1',
      event_type: 'tool.invoked', status: 'pending', action: 'tool.invoked',
    });
  });

  it('is idempotent — a replayed activity collapses everywhere (including the outbox)', async () => {
    await sut.repo.persistTurnAtomic(bundle(), {tenantId: TENANT});
    expect(await count('audit.audit_events')).toBe(2);
    expect(await count('audit.usage_records')).toBe(1);
    expect(await count('event.event_outbox')).toBe(2);
  });

  it('is ATOMIC — a poisoned batch rolls back EVERY table, not just the failing one', async () => {
    const poisoned = bundle();
    // Fresh ids so nothing collapses against the committed rows...
    poisoned.ledger.toolExecutions[0] = {
      ...poisoned.ledger.toolExecutions[0], toolCallId: 'tc_atomic_2', idempotencyKey: 'idem-atomic-2',
    };
    poisoned.ledger.policyDecisions[0] = {...poisoned.ledger.policyDecisions[0], decisionId: 'pld_atomic_2'};
    poisoned.handoff = {...poisoned.handoff!, handoffId: 'hof_atomic_2'};
    poisoned.auditEvents = [auditEvent('aud_atomic_3', 'tool.invoked')];
    // ...except the usage event, which violates a NOT NULL at the END of the transaction.
    poisoned.usageEvents = [{...usageEvent, dedupeKey: 'dk_atomic_2', meterKind: null as never}];

    await expect(sut.repo.persistTurnAtomic(poisoned, {tenantId: TENANT})).rejects.toThrow();

    // NOTHING from the poisoned batch committed — counts are exactly the pre-failure state.
    expect(await count('runtime.tool_executions')).toBe(1);
    expect(await count('runtime.policy_decisions')).toBe(1);
    expect(await count('runtime.handoff_tasks')).toBe(1);
    expect(await count('audit.audit_events')).toBe(2);
    expect(await count('event.event_outbox')).toBe(2);
    expect(await count('audit.usage_records')).toBe(1);
  });

  it('outbox rows are tenant-isolated (RLS strict) — another tenant scope cannot enqueue across', async () => {
    // The WITH CHECK policy rejects a row whose tenant_id differs from the pinned GUC.
    const crossTenant = bundle();
    crossTenant.auditEvents = [
      {...auditEvent('aud_atomic_x', 'tool.invoked'), tenantId: 'tnt_other' as TenantId} as AuditEvent,
    ];
    crossTenant.usageEvents = [];
    crossTenant.handoff = undefined;
    await expect(sut.repo.persistTurnAtomic(crossTenant, {tenantId: TENANT})).rejects.toThrow();
  });
});
