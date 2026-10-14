// The `audit` schema. Append-only, immutable, tamper-evident records of every material action (ADR-009/012)
// plus deduped, billable usage_records. Every row is tenant-owned (tenant_id NOT NULL) and RLS-protected.
import {pgSchema, text, timestamp, jsonb, numeric, index} from 'drizzle-orm/pg-core';

export const audit = pgSchema('audit');

/* ------------------------------------------------------------------ *
 * audit.audit_events — append-only immutable audit trail.
 * Aligns column-for-column to AuditEvent.
 * ------------------------------------------------------------------ */
export const auditEvents = audit.table('audit_events', {
  id: text('id').primaryKey(),                                  // AuditEventId 'aud_...'
  tenantId: text('tenant_id').notNull(),
  principalId: text('principal_id').notNull(),
  action: text('action').notNull().$type<
    'tool.invoked'|'tool.denied'|'message.sent'|'message.received'|'decision.rule'|'decision.policy'|
    'handoff.requested'|'handoff.resolved'|'deployment.published'|'definition.published'|'tenant.config.changed'
  >(),
  correlationId: text('correlation_id').notNull(),
  turnId: text('turn_id'),
  conversationId: text('conversation_id'),
  subject: text('subject').notNull(),
  detail: jsonb('detail').notNull().default({}),
  outcome: text('outcome').notNull().$type<'success'|'denied'|'error'>(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  integrityHash: text('integrity_hash').notNull(),
}, t => ({
  tenantCorrelationIdx: index('ae_tenant_correlation_idx').on(t.tenantId, t.correlationId),
  tenantOccurredIdx: index('ae_tenant_occurred_idx').on(t.tenantId, t.occurredAt),
  tenantActionIdx: index('ae_tenant_action_idx').on(t.tenantId, t.action),
}));

/* ------------------------------------------------------------------ *
 * audit.usage_records — deduped, billable usage aggregate. dedupe_key is the PK: it enforces
 * exactly-once billing under at-least-once emission (findings T7). Aligns to UsageRecord.
 * ------------------------------------------------------------------ */
export const usageRecords = audit.table('usage_records', {
  dedupeKey: text('dedupe_key').primaryKey(),                   // enforces exactly-once billing (T7)
  tenantId: text('tenant_id').notNull(),
  principalId: text('principal_id').notNull(),
  meterKind: text('meter_kind').notNull().$type<
    'model.input.tokens'|'model.output.tokens'|'model.cost.usd'|'tool.invocation'|'message.sent'|'storage.vector'
  >(),
  quantity: numeric('quantity').notNull(),
  unit: text('unit').notNull().$type<'tokens'|'usd'|'count'|'bytes'>(),
  correlationId: text('correlation_id').notNull(),
  turnId: text('turn_id'),
  period: text('period').notNull(),                              // 'YYYY-MM'
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  tenantPeriodMeterIdx: index('ur_tenant_period_meter_idx').on(t.tenantId, t.period, t.meterKind),
}));
