// DrizzleAuditQueryService (read side of the audit trail): composes an incident
// timeline by joining audit_events ⋈ tool_executions ⋈ policy_decisions ⋈ evidence_records for a
// (tenant, correlationId). audit_events + policy_decisions carry correlation_id directly; tool_executions
// + evidence_records link by turn_id, so we first resolve the correlation's turnIds (from the audit/policy
// rows, plus the correlationId itself for turn-scoped ids) then gather the turn-linked rows. Read-only,
// tenant-scoped (RLS). Tombstone/crypto-shred rendering is deferred (data-retention not built — flagged).
import {and, eq, inArray} from 'drizzle-orm';
import {
  AuditTimelineEntry,
  type AuditAction,
  type AuditEvent,
  type AuditQueryService,
  type TenantId,
} from '@hermes-one/contracts';
import {
  TenantAwareRepository,
  type PlatformTx,
} from './tenant-aware.repository.js';
import {auditEvents} from './schema/audit.schema.js';
import {
  toolExecutions,
  evidenceRecords,
  policyDecisions,
} from './schema/runtime.schema.js';

const iso = (d: Date) => d.toISOString();

export class DrizzleAuditQueryService
  extends TenantAwareRepository
  implements AuditQueryService
{
  async composeTimeline(
    tenantId: TenantId,
    correlationId: string,
  ): Promise<AuditTimelineEntry[]> {
    return this.withTenant({tenantId}, async (tx: PlatformTx) => {
      const audits = await tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.correlationId, correlationId));
      const policies = await tx
        .select()
        .from(policyDecisions)
        .where(eq(policyDecisions.correlationId, correlationId));

      // Resolve every turn under this correlation, plus the correlationId itself (turn-scoped ids).
      const turnIds = [
        ...new Set([
          correlationId,
          ...audits.map(a => a.turnId).filter((t): t is string => !!t),
          ...policies.map(p => p.turnId).filter((t): t is string => !!t),
        ]),
      ];
      const tools = turnIds.length
        ? await tx
            .select()
            .from(toolExecutions)
            .where(inArray(toolExecutions.turnId, turnIds))
        : [];
      const evidence = turnIds.length
        ? await tx
            .select()
            .from(evidenceRecords)
            .where(inArray(evidenceRecords.turnId, turnIds))
        : [];

      // Build plain objects; AuditTimelineEntry.array().parse validates + brands them at runtime.
      const entries: unknown[] = [];

      for (const a of audits) {
        entries.push({
          kind: 'audit',
          occurredAt: iso(a.occurredAt),
          correlationId,
          turnId: a.turnId ?? null,
          detail: {
            id: a.id,
            tenantId: a.tenantId,
            principalId: a.principalId,
            action: a.action,
            correlationId: a.correlationId,
            turnId: a.turnId ?? null,
            conversationId: a.conversationId ?? null,
            subject: a.subject,
            detail: a.detail ?? {},
            outcome: a.outcome,
            occurredAt: iso(a.occurredAt),
            integrityHash: a.integrityHash,
          },
        });
      }
      for (const p of policies) {
        entries.push({
          kind: 'policy-decision',
          occurredAt: iso(p.decidedAt),
          correlationId,
          turnId: p.turnId ?? null,
          detail: {
            outcome: p.outcome,
            policyRuleId: p.policyRuleId,
            reason: p.reason,
            ...(p.detail ? {detail: p.detail} : {}),
            decidedAt: iso(p.decidedAt),
          },
        });
      }
      for (const t of tools) {
        entries.push({
          kind: 'tool-execution',
          occurredAt: iso(t.executedAt),
          correlationId,
          turnId: t.turnId ?? null,
          detail: {
            toolCallId: t.toolCallId,
            capability: t.capabilityName,
            ok: t.ok,
            output: t.output ?? null,
            sideEffect: t.sideEffect,
            stateChanged: t.stateChanged,
            changedDomains: t.changedDomains,
            evidence: [],
            metrics: t.metrics,
            error: t.error ?? null,
          },
        });
      }
      for (const e of evidence) {
        entries.push({
          kind: 'evidence',
          occurredAt: iso(e.observedAt),
          correlationId,
          turnId: e.turnId ?? null,
          detail: {
            id: e.id,
            turnId: e.turnId,
            toolCallId: e.toolCallId ?? null,
            kind: e.kind,
            capability: e.capabilityName ?? null,
            statement: e.statement,
            data: e.data,
            source: e.source,
            trusted: e.trusted,
            observedAt: iso(e.observedAt),
          },
        });
      }

      const parsed = AuditTimelineEntry.array().parse(entries);
      parsed.sort((x, y) => x.occurredAt.localeCompare(y.occurredAt));
      return parsed;
    });
  }

  async queryAuditEvents(
    tenantId: TenantId,
    filter: {correlationId?: string; action?: AuditAction},
  ): Promise<AuditEvent[]> {
    return this.withTenant({tenantId}, async (tx: PlatformTx) => {
      const conds = [eq(auditEvents.tenantId, tenantId)];
      if (filter.correlationId)
        conds.push(eq(auditEvents.correlationId, filter.correlationId));
      if (filter.action) conds.push(eq(auditEvents.action, filter.action));
      const rows = await tx
        .select()
        .from(auditEvents)
        .where(and(...conds));
      return rows.map(a => ({
        id: a.id,
        tenantId: a.tenantId,
        principalId: a.principalId,
        action: a.action,
        correlationId: a.correlationId,
        turnId: a.turnId ?? null,
        conversationId: a.conversationId ?? null,
        subject: a.subject,
        detail: (a.detail ?? {}) as Record<string, unknown>,
        outcome: a.outcome,
        occurredAt: iso(a.occurredAt),
        integrityHash: a.integrityHash,
      })) as unknown as AuditEvent[];
    });
  }
}
