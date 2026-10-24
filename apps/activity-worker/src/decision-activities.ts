// The deterministic-rail audit signal: when a workflow rule node resolves a decision with ZERO LLM call,
// emit a `decision.rule` AuditEvent. This is the numerator of the deterministic-hit-rate KPI
// — the platform's headline scalability metric. The id +
// integrityHash are deterministic over the decision so a Temporal workflow replay re-emits an identical
// event that collapses via the append's ON CONFLICT DO NOTHING.
import {createHash} from 'node:crypto';
import type {
  AuditEvent,
  IsoTimestamp,
  PrincipalId,
  TenantId,
} from '@hermes-one/contracts';
import type {DrizzleAuditSink} from '@hermes-one/drizzle';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

export interface EmitDecisionRuleArgs {
  tenantId: string;
  correlationId: string;
  outcome: string; // the rule's routing outcome
  rulePlanId: string;
  occurredAt: string; // workflow clock (deterministic across replay)
  /**
   * Deterministic per-run rule-visit ordinal, maintained IN THE WORKFLOW (replay-stable). Part of the
   * id material (mirrors the per-turn seq in agent-worker audit-events.ts): without it a plan that
   * revisits the same rule node with the same outcome reused the id while the integrityHash (which
   * covers occurredAt — the workflow clock, different per visit) differed → tamper-reject (409,
   * non-retryable) killed the run.
   */
  visitSeq: number;
}

export function createDecisionActivities(audit: DrizzleAuditSink) {
  return {
    async emitDecisionRule(a: EmitDecisionRuleArgs): Promise<void> {
      const row = {
        tenantId: a.tenantId as TenantId,
        principalId: 'prn_system' as PrincipalId,
        action: 'decision.rule' as const,
        correlationId: a.correlationId,
        turnId: null, // a deterministic decision is not an agent turn
        conversationId: null,
        subject: a.rulePlanId,
        detail: {outcome: a.outcome},
        outcome: 'success' as const,
        occurredAt: a.occurredAt as IsoTimestamp,
      };
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
      const id =
        `aud_${sha256hex(`${a.correlationId}:decision.rule:${a.rulePlanId}:${a.outcome}:${a.visitSeq}`).slice(0, 24)}` as AuditEvent['id'];
      await audit.append({
        ...row,
        id,
        integrityHash: `sha256:${sha256hex(canonical)}`,
      });
    },
  };
}
