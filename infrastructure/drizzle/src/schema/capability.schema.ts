// The `capability` schema: tenant-specific overrides of a capability's default ProviderMapping (the
// default itself ships inside the content-hashed capability contract). Absence of a row = use the
// contract's default. RLS-protected (strict).
import {pgSchema, text, timestamp, jsonb, uniqueIndex} from 'drizzle-orm/pg-core';

export const capability = pgSchema('capability');

/**
 * One tenant's ENVELOPE-ENCRYPTED credential set for one provider serving one capability (ADR-026).
 * `ciphertext` = the encrypted JSON bundle; `keyRef` names the wrapping key (local:<id> dev, KMS CMK
 * prod). Plaintext credentials never touch a column. RLS strict (migration 0030).
 */
export const providerCredentials = capability.table('provider_credentials', {
  credentialId: text('credential_id').primaryKey(), // 'pvc_...'
  tenantId: text('tenant_id').notNull(),
  providerId: text('provider_id').notNull(),
  capability: text('capability').notNull(),
  ciphertext: text('ciphertext').notNull(),
  keyRef: text('key_ref').notNull(),
  status: text('status').notNull().$type<'active' | 'rotating' | 'revoked'>().default('active'),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  tenantProviderCapabilityUq: uniqueIndex('pc_tenant_provider_capability_uq').on(t.tenantId, t.providerId, t.capability),
}));

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
