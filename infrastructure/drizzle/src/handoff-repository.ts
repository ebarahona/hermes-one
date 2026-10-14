// Tenant-scoped writer for runtime.handoff_tasks (RLS 'strict') — the durable store behind
// platform.data.handoff-repository. This build persists the INITIAL request row a
// turn writes when it hands off (status 'requested', owner 'agent'); the ownership lifecycle
// (assign/takeover/resolve via Temporal signals + admin inbox) is a later build (flagged). Idempotent on
// handoff_id so a replayed turn collapses. All access goes through withTenant → set_config('app.tenant_id').
import type {TenantId, TenantScope} from '@platform/contracts';
import {TenantAwareRepository, type PlatformTx} from './tenant-aware.repository.js';
import {handoffTasks} from './schema/runtime.schema.js';

export interface HandoffTaskRow {
  handoffId: string;
  conversationId: string;
  triggeringTurnId?: string;
  reason: 'policy-required' | 'agent-uncertain' | 'customer-requested' | 'error-escalation' | 'high-value';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  summary: string;
  evidenceSnapshot: unknown[];
  queue: string;
  operatorId?: string;
  status: 'requested' | 'assigned' | 'human_owned' | 'resolved' | 'returned' | 'expired';
  owner: 'agent' | 'human';
  transitions: unknown[];
  requestedAt: Date;
  expiresAt?: Date;
  updatedAt?: Date;
}

/** Tx-scoped write core (shared with the atomic DrizzleTurnPersistence writer). */
export async function insertHandoffRequest(tx: PlatformTx, tenantId: TenantId, row: HandoffTaskRow): Promise<void> {
  await tx
    .insert(handoffTasks)
    .values({
      handoffId: row.handoffId,
      tenantId,
      conversationId: row.conversationId,
      triggeringTurnId: row.triggeringTurnId,
      reason: row.reason,
      priority: row.priority,
      summary: row.summary,
      evidenceSnapshot: row.evidenceSnapshot,
      queue: row.queue,
      operatorId: row.operatorId,
      status: row.status,
      owner: row.owner,
      transitions: row.transitions,
      requestedAt: row.requestedAt,
      ...(row.expiresAt ? {expiresAt: row.expiresAt} : {}),
      ...(row.updatedAt ? {updatedAt: row.updatedAt} : {}),
    })
    .onConflictDoNothing({target: handoffTasks.handoffId});
}

export class DrizzleHandoffRepository extends TenantAwareRepository {
  /** Persist a handoff request for a tenant. Idempotent — a replayed turn collapses (ON CONFLICT DO NOTHING). */
  async requestHandoff(row: HandoffTaskRow, scope: TenantScope): Promise<void> {
    await this.withTenant(scope, tx => insertHandoffRequest(tx, scope.tenantId, row));
  }
}
