// The `capability` schema: tenant-specific overrides of a capability's default ProviderMapping (the
// default itself ships inside the content-hashed capability contract). Absence of a row = use the
// contract's default. RLS-protected (strict). Verbatim from database/table-catalog.md.
import {pgSchema, text, timestamp, jsonb, uniqueIndex} from 'drizzle-orm/pg-core';

export const capability = pgSchema('capability');

export const providerMappings = capability.table('provider_mappings', {
  providerMappingId: text('provider_mapping_id').primaryKey(),  // 'pvm_...'
  tenantId: text('tenant_id').notNull(),
  capabilityName: text('capability_name').notNull(),
  providers: jsonb('providers').notNull(),                       // ProviderRef[]
  eligibility: jsonb('eligibility').notNull().default([]),       // EligibilityRule[]
  onNoProvider: text('on_no_provider').notNull().$type<'fail'|'handoff'>().default('fail'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by').notNull(),
}, t => ({
  tenantCapabilityUq: uniqueIndex('pm_tenant_capability_uq').on(t.tenantId, t.capabilityName),
}));
