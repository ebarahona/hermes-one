// Admin-surface audit events. `tenant.config.changed` (outbox-backed,
// aggregate 'audit_event', trigger: tenant feature-flag/quota-profile edit) rides the tenant UPDATE's
// own transaction via the repository's events parameter — commit-and-publish, the same F3 rule as the
// substrate writer. Identity recipe: same canonical integrityHash material as every other producer
// ("sha256 of the row minus id"); the id covers the ACT — correlationId is the
// REQUEST's correlation id (unique per request), so each PATCH is its own audit row and a same-request
// transactional retry collapses.
import {createHash} from 'node:crypto';
import type {AuditEvent, IsoTimestamp, PrincipalId, TenantId} from '@platform/contracts';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

export function tenantConfigChangedEvent(args: {
  tenantId: TenantId;
  actor: PrincipalId;
  correlationId: string;
  /** Field NAMES that changed — never the values (displayName may carry PII; features may leak plans). */
  changedFields: string[];
  occurredAt: IsoTimestamp;
}): AuditEvent {
  const row = {
    tenantId: args.tenantId,
    principalId: args.actor,
    action: 'tenant.config.changed' as const,
    correlationId: args.correlationId,
    turnId: null,
    conversationId: null,
    subject: args.tenantId as string,
    detail: {changedFields: args.changedFields},
    outcome: 'success' as const,
    occurredAt: args.occurredAt,
  };
  const canonical = JSON.stringify([
    row.tenantId, row.principalId, row.action, row.correlationId, row.turnId, row.conversationId,
    row.subject, row.detail, row.outcome, row.occurredAt,
  ]);
  const id = `aud_${sha256hex(`${row.correlationId}:${row.action}:${row.subject}:${row.occurredAt}`).slice(0, 24)}`;
  return {...row, id, integrityHash: `sha256:${sha256hex(canonical)}`} as unknown as AuditEvent;
}
