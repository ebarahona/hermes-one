// Atomic turn persistence (triage F3): ONE tenant-scoped transaction commits the whole durable record
// of a completed agent turn — the turn ledger (tool_executions / evidence_records / policy_decisions),
// the initial handoff_tasks request, the audit trail, the usage records, AND one event.event_outbox row
// per audit event ("commit-and-publish", events/event-envelope.md: the outbox row is written in the SAME
// transaction as the domain row it fans out from). A crash mid-persist leaves NOTHING: no ledger without
// its audit trail, no audit row whose domain event never enters the outbox. Every insert is idempotent
// (ON CONFLICT DO NOTHING on PK / dedupe key) so a Temporal activity retry collapses to the same rows.
//
// FLAGGED: usage_records are committed atomically here but do NOT enqueue outbox rows yet — the billing
// fan-out catalog is events/billing-events.md (follow-up); audit events are the domain-event source.
import type {AuditEvent, TenantScope, UsageEvent} from '@platform/contracts';
import {TenantAwareRepository} from './tenant-aware.repository.js';
import {insertTurnLedger, type TurnLedgerRows} from './turn-ledger-repository.js';
import {insertHandoffRequest, type HandoffTaskRow} from './handoff-repository.js';
import {insertAuditEvent} from './audit-repository.js';
import {insertUsageRecord} from './usage-repository.js';
import {enqueueOutboxRow, deriveOutboxId} from './event-outbox-repository.js';

export interface TurnPersistenceBundle {
  ledger: TurnLedgerRows;
  handoff?: HandoffTaskRow;
  auditEvents: AuditEvent[];
  usageEvents: UsageEvent[];
}

export class DrizzleTurnPersistence extends TenantAwareRepository {
  /** Commit the whole turn record atomically — all rows or none; replay collapses idempotently. */
  async persistTurnAtomic(bundle: TurnPersistenceBundle, scope: TenantScope): Promise<void> {
    await this.withTenant(scope, async tx => {
      await insertTurnLedger(tx, scope.tenantId, bundle.ledger);
      if (bundle.handoff) await insertHandoffRequest(tx, scope.tenantId, bundle.handoff);
      for (const event of bundle.auditEvents) {
        await insertAuditEvent(tx, event);
        // Commit-and-publish: the audit event IS the domain event — its outbox row rides the same
        // transaction, keyed deterministically so replays collapse (obx_<audit id>).
        await enqueueOutboxRow(tx, {
          outboxId: deriveOutboxId(event.id),
          tenantId: event.tenantId,
          aggregateType: 'audit_event',
          aggregateId: event.id,
          eventType: event.action,
          payload: event as unknown as Record<string, unknown>,
        });
      }
      for (const event of bundle.usageEvents) await insertUsageRecord(tx, event);
    });
  }
}
