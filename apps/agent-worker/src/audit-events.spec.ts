import {describe, expect, it} from 'vitest';
import type {
  ConversationId, IsoTimestamp, PrincipalId, TenantId, ToolCall, ToolResult, TurnId,
} from '@platform/contracts';
import type {TurnLedger} from '@platform-internal/agent-runtime';
import {deriveAuditEvents} from './audit-events.js';

const NOW = '2026-07-13T00:00:00.000Z' as IsoTimestamp;

const call: ToolCall = {
  toolCallId: 'tc_1' as ToolCall['toolCallId'],
  capability: 'appointment.slot.read' as ToolCall['capability'],
  input: {date: '2026-07-14'},
  idempotencyKey: 'idem-1',
  proposedAt: NOW,
};
const okResult: ToolResult = {
  toolCallId: 'tc_1' as ToolResult['toolCallId'],
  capability: 'appointment.slot.read' as ToolResult['capability'],
  ok: true, output: {slots: []}, sideEffect: 'read', stateChanged: false, changedDomains: ['none'],
  evidence: [], metrics: {latencyMs: 5, providerId: 'p', retries: 0, costUsd: 0, idempotentReplay: false}, error: null,
};

const ledger: TurnLedger = {
  turnId: 'trn_a' as TurnId,
  tenantId: 'tnt_a' as TenantId,
  correlationId: 'trn_a',
  toolExecutions: [{call, result: okResult}],
  evidence: [],
  usage: {modelCostUsd: 0, inputTokens: 0, outputTokens: 0, toolCount: 1},
  policyDecisions: [
    {decisionId: 'pld_1', site: 'preGate', decision: {outcome: 'allow', policyRuleId: '<default>', reason: 'ok', decidedAt: NOW}, capability: 'appointment.slot.read' as ToolCall['capability']},
    {decisionId: 'pld_2', site: 'preGate', decision: {outcome: 'deny', policyRuleId: 'r_block', reason: 'blocked', decidedAt: NOW}, capability: 'appointment.booking.create' as ToolCall['capability']},
  ],
  handoff: {
    handoffId: 'hof_1' as import('@platform/contracts').HandoffId,
    reason: 'policy-required',
    summary: 'needs a human',
    evidenceSnapshot: [],
    triggeringTurnId: 'trn_a' as TurnId,
    conversationId: 'cnv_a' as ConversationId,
  },
};
const ctx = {principalId: 'prn_a' as PrincipalId, conversationId: 'cnv_a' as ConversationId, occurredAt: NOW};

describe('deriveAuditEvents', () => {
  it('derives one event per material action with correct action + outcome', () => {
    const events = deriveAuditEvents(ledger, ctx);
    const byAction = events.map(e => [e.action, e.outcome, e.subject]);
    expect(byAction).toEqual([
      ['tool.invoked', 'success', 'appointment.slot.read'],
      ['decision.policy', 'success', 'appointment.slot.read'], // allow → success
      ['decision.policy', 'denied', 'appointment.booking.create'], // deny → denied
      ['handoff.requested', 'success', 'hof_1'],
    ]);
    for (const e of events) {
      expect(e.id).toMatch(/^aud_[0-9a-f]{24}$/);
      expect(e.integrityHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(e.correlationId).toBe('trn_a');
      expect(e.principalId).toBe('prn_a');
    }
  });

  it('is deterministic — same ledger → identical ids + integrity hashes (replay-safe)', () => {
    const a = deriveAuditEvents(ledger, ctx);
    const b = deriveAuditEvents(ledger, ctx);
    expect(a.map(e => e.id)).toEqual(b.map(e => e.id));
    expect(a.map(e => e.integrityHash)).toEqual(b.map(e => e.integrityHash));
  });

  it('folds the turn identity into the id — two visits with the same actions/subjects/seq derive distinct ids', () => {
    // Two agent-node visits in one run: same workflow correlationId, same actions/subjects, only the
    // turnId (per-visit sequence) differs. Ids must be pairwise distinct or the second visit's persist
    // tamper-rejects (the integrityHash covers turnId + occurredAt and always differs).
    const secondVisit: TurnLedger = {...ledger, turnId: 'trn_a_1' as TurnId};
    const first = deriveAuditEvents(ledger, ctx);
    const second = deriveAuditEvents(secondVisit, ctx);
    first.forEach((e, i) => expect(second[i].id).not.toBe(e.id));
    // Re-derivation under the SAME turnId (a Temporal retry of that turn) is stable.
    expect(deriveAuditEvents(secondVisit, ctx).map(e => e.id)).toEqual(second.map(e => e.id));
  });

  it('marks a failed tool invocation as error', () => {
    const failed = {...ledger, toolExecutions: [{call, result: {...okResult, ok: false, error: {code: 'x', message: 'boom', retryable: false}}}], policyDecisions: [], handoff: undefined};
    const events = deriveAuditEvents(failed as TurnLedger, ctx);
    expect(events[0].outcome).toBe('error');
  });
});
