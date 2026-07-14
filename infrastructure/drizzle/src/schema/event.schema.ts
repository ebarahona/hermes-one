// The `event` schema: the transactional outbox backing "commit-and-publish". An outbox row is written in
// the SAME transaction as the domain row it fans out from; a separate publisher polls status='pending'
// and dispatches to Redis pub/sub or a broker, then marks 'published'. RLS-protected (strict). Verbatim
// from database/table-catalog.md.
import {pgSchema, text, timestamp, jsonb, integer, bigserial, index, uniqueIndex} from 'drizzle-orm/pg-core';

export const event = pgSchema('event');

export const eventOutbox = event.table('event_outbox', {
  outboxId: text('outbox_id').primaryKey(),                     // 'obx_...', storage-only
  sequence: bigserial('sequence', { mode: 'bigint' }).notNull(), // ordered poll cursor
  tenantId: text('tenant_id').notNull(),
  aggregateType: text('aggregate_type').notNull(),               // 'audit_event' | 'usage_record' | 'handoff_task' | ...
  aggregateId: text('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().$type<'pending'|'published'|'failed'>().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, t => ({
  sequenceUq: uniqueIndex('eo_sequence_uq').on(t.sequence),
  tenantIdx: index('eo_tenant_idx').on(t.tenantId),
}));
