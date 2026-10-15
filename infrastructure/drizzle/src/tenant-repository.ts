// DrizzleTenantRepository — the tenant-scoped read/update surface over `tenant.tenants`
// Self-scoping via
// withTenant (the tenants RLS policy keys on tenant_id = app.tenant_id — a principal only sees/updates
// its OWN tenant row). Returns the canonical TenantContext. Cross-tenant
// create/list is a platform-operator surface (deferred on the relay-role posture) — not here.
import {eq, sql} from 'drizzle-orm';
import {
  PlatformErrorException,
  TenantContext,
  type AuditEvent,
  type TenantId,
  type TenantStatus,
} from '@platform/contracts';
import {TenantAwareRepository} from './tenant-aware.repository.js';
import {insertAuditEvent} from './audit-repository.js';
import {enqueueOutboxRow, deriveOutboxId} from './event-outbox-repository.js';
import {tenants} from './schema/tenant.schema.js';

/** A partial update (only these fields are mutable here). */
export interface TenantPatch {
  displayName?: string;
  status?: TenantStatus;
  features?: Record<string, boolean>;
}

type TenantRow = typeof tenants.$inferSelect;

function toContext(row: TenantRow): TenantContext {
  return TenantContext.parse({
    tenantId: row.id,
    slug: row.slug,
    displayName: row.displayName,
    status: row.status,
    dataResidency: row.dataResidency,
    features: row.features,
    createdAt: row.createdAt.toISOString(),
  });
}

export class DrizzleTenantRepository extends TenantAwareRepository {
  private notFound(tenantId: string): PlatformErrorException {
    return new PlatformErrorException({
      category: 'not-found',
      code: 'not_found',
      message: `tenant not found: ${tenantId}`,
      issues: [],
      retryable: false,
      httpStatus: 404,
    });
  }

  async getTenant(tenantId: TenantId): Promise<TenantContext> {
    return this.withTenant({tenantId}, async tx => {
      const [row] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      if (!row) throw this.notFound(tenantId);
      return toContext(row);
    });
  }

  /** `events` (audit + outbox envelopes) commit in the SAME transaction as the update (F3 rule). */
  async updateTenant(
    tenantId: TenantId,
    patch: TenantPatch,
    events: AuditEvent[] = [],
  ): Promise<TenantContext> {
    return this.withTenant({tenantId}, async tx => {
      const fields: Partial<typeof tenants.$inferInsert> = {};
      if (patch.displayName !== undefined)
        fields.displayName = patch.displayName;
      if (patch.status !== undefined) fields.status = patch.status;
      if (patch.features !== undefined) fields.features = patch.features;
      const [row] = await tx
        .update(tenants)
        .set({
          ...fields,
          updatedAt: new Date(),
          version: sql`${tenants.version} + 1`,
        })
        .where(eq(tenants.id, tenantId))
        .returning();
      if (!row) throw this.notFound(tenantId);
      for (const event of events) {
        await insertAuditEvent(tx, event);
        await enqueueOutboxRow(tx, {
          outboxId: deriveOutboxId(event.id),
          tenantId: event.tenantId,
          aggregateType: 'audit_event',
          aggregateId: event.id,
          eventType: event.action,
          payload: event as unknown as Record<string, unknown>,
        });
      }
      return toContext(row);
    });
  }
}
