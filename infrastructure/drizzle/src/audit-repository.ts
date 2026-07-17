// Tenant-scoped, append-only writer for audit.audit_events (RLS 'strict') — the store behind
// platform.audit.sink (audit-contracts.md). Implements the canonical AuditSink port.
//
// APPEND SEMANTICS (audit-contracts.md: "Append-only; throws if `id`/`integrityHash` already exists
// (idempotent on replay)" + "`append` rejects a duplicate id/hash, making replay idempotent AND
// MUTATION DETECTABLE"). One rule, keyed on the hash:
//   same id + same integrityHash  → a genuine replay (workflow reset / re-execution) → no-op;
//   same id + DIFFERENT hash      → the id is being reused for different content → THROW.
// SAFE ONLY because every producer derives occurredAt from a replay-stable clock: the edge decision
// activities take it from the workflow clock (their args), and the agent turn from
// TurnRequest.startedAt (Phase 2a) — a wall-clock producer would make every re-execution look like
// tampering and poison the enclosing persistTurnAtomic transaction.
import {and, eq, sql} from 'drizzle-orm';
import {PlatformErrorException, type AuditAction, type AuditEvent, type AuditSink, type TenantId} from '@platform/contracts';
import {TenantAwareRepository, type PlatformTx} from './tenant-aware.repository.js';
import {auditEvents} from './schema/audit.schema.js';

/** Raised when an existing audit id is re-appended with different content (tamper/id-collision). */
function auditIntegrityConflict(event: AuditEvent, existingHash: string): PlatformErrorException {
  return new PlatformErrorException({
    category: 'conflict',
    code: 'idempotency_conflict',
    // Hashes are the evidence; the DETAIL is deliberately not echoed (it may carry PII).
    message:
      `Audit event ${event.id} already exists with a different integrityHash ` +
      `(existing ${existingHash}, incoming ${event.integrityHash}) — the audit trail is append-only.`,
    issues: [],
    retryable: false,
    httpStatus: 409,
  });
}

/** Tx-scoped write core (shared with the atomic DrizzleTurnPersistence writer). */
export async function insertAuditEvent(tx: PlatformTx, event: AuditEvent): Promise<void> {
  const inserted = await tx
    .insert(auditEvents)
    .values({
      id: event.id,
      tenantId: event.tenantId,
      principalId: event.principalId,
      action: event.action,
      correlationId: event.correlationId,
      turnId: event.turnId ?? undefined,
      conversationId: event.conversationId ?? undefined,
      subject: event.subject,
      detail: event.detail,
      outcome: event.outcome,
      occurredAt: new Date(event.occurredAt),
      integrityHash: event.integrityHash,
    })
    .onConflictDoNothing({target: auditEvents.id})
    .returning({id: auditEvents.id});

  if (inserted.length > 0) return; // fresh append

  // Conflict on id: replay (same hash) or mutation (different hash)? The hash decides.
  const existing = await tx
    .select({integrityHash: auditEvents.integrityHash})
    .from(auditEvents)
    .where(eq(auditEvents.id, event.id));
  const existingHash = existing[0]?.integrityHash;
  // No visible row despite the conflict = another tenant owns this id (RLS hides it). Same verdict:
  // the id is taken by content we cannot vouch for — refuse rather than silently drop the event.
  if (existingHash !== event.integrityHash) {
    throw auditIntegrityConflict(event, existingHash ?? '<not visible to this tenant>');
  }
}

export class DrizzleAuditSink extends TenantAwareRepository implements AuditSink {
  /** Append one immutable audit event. Idempotent on a true replay; rejects a mutated re-append. */
  async append(event: AuditEvent): Promise<void> {
    await this.withTenant({tenantId: event.tenantId}, tx => insertAuditEvent(tx, event));
  }

  /** Count events of one action for a tenant in a billing period ('YYYY-MM'). Feeds scalability KPIs. */
  async countByAction(tenantId: TenantId, action: AuditAction, period: string): Promise<number> {
    return this.withTenant({tenantId}, async tx => {
      const rows = await tx
        .select({n: sql<number>`count(*)::int`})
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.tenantId, tenantId),
            eq(auditEvents.action, action),
            sql`to_char(${auditEvents.occurredAt}, 'YYYY-MM') = ${period}`,
          ),
        );
      return rows[0]?.n ?? 0;
    });
  }

  /** Tenant-scoped read of the audit trail, optionally filtered by correlation/action. */
  async query(filter: {tenantId: TenantId; correlationId?: string; action?: AuditAction}): Promise<AuditEvent[]> {
    return this.withTenant({tenantId: filter.tenantId}, async tx => {
      const conds = [eq(auditEvents.tenantId, filter.tenantId)];
      if (filter.correlationId) conds.push(eq(auditEvents.correlationId, filter.correlationId));
      if (filter.action) conds.push(eq(auditEvents.action, filter.action));
      const rows = await tx.select().from(auditEvents).where(and(...conds));
      return rows.map(r => ({
        id: r.id,
        tenantId: r.tenantId,
        principalId: r.principalId,
        action: r.action,
        correlationId: r.correlationId,
        turnId: r.turnId ?? null,
        conversationId: r.conversationId ?? null,
        subject: r.subject,
        detail: (r.detail ?? {}) as Record<string, unknown>,
        outcome: r.outcome,
        occurredAt: r.occurredAt.toISOString(),
        integrityHash: r.integrityHash,
      })) as AuditEvent[];
    });
  }
}
