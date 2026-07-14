// Tenant-scoped, append-only writer for audit.audit_events (RLS 'strict') — the store behind
// platform.audit.sink (audit-contracts.md). Implements the canonical AuditSink port. Append is idempotent
// on the event id (ON CONFLICT DO NOTHING) so a Temporal activity retry / actor replay that re-emits the
// same event collapses to one row. All access goes through withTenant → set_config('app.tenant_id').
import {and, eq, sql} from 'drizzle-orm';
import type {AuditAction, AuditEvent, AuditSink, TenantId} from '@platform/contracts';
import {TenantAwareRepository, type PlatformTx} from './tenant-aware.repository.js';
import {auditEvents} from './schema/audit.schema.js';

/** Tx-scoped write core (shared with the atomic DrizzleTurnPersistence writer). */
export async function insertAuditEvent(tx: PlatformTx, event: AuditEvent): Promise<void> {
  await tx
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
    .onConflictDoNothing({target: auditEvents.id});
}

export class DrizzleAuditSink extends TenantAwareRepository implements AuditSink {
  /** Append one immutable audit event. Idempotent on id (replay-safe). */
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
