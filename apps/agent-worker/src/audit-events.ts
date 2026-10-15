// Derive append-only AuditEvents from a completed turn's ledger — an edge concern
// (the agent plane emits contract data; the edge records the audit trail). One event per material action:
// tool.invoked (per tool execution), decision.policy (per gate decision), handoff.requested (on handoff).
// Each id + integrityHash is deterministic over the row — INCLUDING occurredAt, which the caller MUST
// derive from TurnRequest.startedAt (workflow clock), never wall time — so a re-execution re-derives
// byte-identical events
// that collapse via the append's ON CONFLICT DO NOTHING (replay-safe, tamper-evident).
//
// FLAGGED: message.sent/received audit events belong to the channel layer (not the turn) — later.
import {createHash} from 'node:crypto';
import type {
  AuditEvent,
  TurnId,
  ConversationId,
  PrincipalId,
  TenantId,
  IsoTimestamp,
} from '@platform/contracts';
import type {TurnLedger} from '@platform-internal/agent-runtime';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** integrityHash = sha256 of the row minus id (tamper-evidence + replay dedupe), 'sha256:<64hex>'. */
function integrityHash(row: Omit<AuditEvent, 'id' | 'integrityHash'>): string {
  const canonical = JSON.stringify([
    row.tenantId,
    row.principalId,
    row.action,
    row.correlationId,
    row.turnId,
    row.conversationId,
    row.subject,
    row.detail,
    row.outcome,
    row.occurredAt,
  ]);
  return `sha256:${sha256hex(canonical)}`;
}

export function deriveAuditEvents(
  ledger: TurnLedger,
  ctx: {
    principalId: PrincipalId;
    conversationId: ConversationId | null;
    occurredAt: IsoTimestamp;
  },
): AuditEvent[] {
  const events: Omit<AuditEvent, 'id' | 'integrityHash'>[] = [];
  const base = {
    tenantId: ledger.tenantId as TenantId,
    principalId: ctx.principalId,
    correlationId: ledger.correlationId,
    turnId: ledger.turnId as TurnId,
    conversationId: ctx.conversationId,
    occurredAt: ctx.occurredAt,
  };

  for (const {call, result} of ledger.toolExecutions) {
    events.push({
      ...base,
      action: 'tool.invoked',
      subject: call.capability,
      detail: {
        toolCallId: result.toolCallId,
        sideEffect: result.sideEffect,
        changedDomains: result.changedDomains,
      },
      outcome: result.ok ? 'success' : 'error',
    });
  }

  for (const {site, decision, capability} of ledger.policyDecisions) {
    events.push({
      ...base,
      action: 'decision.policy',
      subject: capability ?? decision.policyRuleId,
      detail: {
        site,
        outcome: decision.outcome,
        policyRuleId: decision.policyRuleId,
        reason: decision.reason,
      },
      outcome: decision.outcome === 'deny' ? 'denied' : 'success',
    });
  }

  if (ledger.handoff) {
    events.push({
      ...base,
      action: 'handoff.requested',
      subject: ledger.handoff.handoffId,
      detail: {reason: ledger.handoff.reason, summary: ledger.handoff.summary},
      outcome: 'success',
    });
  }

  // Deterministic id (replay-stable) over the row's material content + its position in the turn. The
  // id's correlation component is the TURN (turnId carries the workflow's per-visit sequence — mirrors
  // the usage dedupeKey): keying on the workflow-wide correlationId made two agent-node visits in one
  // run derive IDENTICAL ids for the same action/subject/seq while the integrityHash (covers turnId +
  // occurredAt) differed → tamper-reject (409 idempotency_conflict, non-retryable) failed the second
  // visit's persist. A Temporal retry of the SAME turn re-derives identical ids (turnId is retry-stable).
  return events.map((row, seq) => {
    const id = `aud_${sha256hex(`${row.turnId}:${row.action}:${row.subject}:${seq}`).slice(0, 24)}`;
    return {...row, id, integrityHash: integrityHash(row)} as AuditEvent;
  });
}
