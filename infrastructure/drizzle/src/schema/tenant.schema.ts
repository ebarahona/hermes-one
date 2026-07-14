// The `tenant` schema: tenants (reused from loopback/repository-patterns.md), workspaces, users, roles,
// and vertical_pack_installations. Every row is tenant-owned and RLS-protected (roles + message_templates
// allow a NULL tenant_id = platform-shared). Verbatim from database/table-catalog.md — EXCEPT
// tenant.tenants ids: TEXT brands per the CT1 decision (2026-07-14, migration 0028), a deliberate
// deviation from repository-patterns.md's uuid columns.
import {pgSchema, text, timestamp, jsonb, integer, index, uniqueIndex} from 'drizzle-orm/pg-core';

export const tenant = pgSchema('tenant');

/* ------------------------------------------------------------------ *
 * tenant.tenants — reused from loopback/repository-patterns.md (+ a unique index on slug);
 * ids are the text `tnt_…` brand (CT1 decision, migration 0028).
 * ------------------------------------------------------------------ */
export const tenants = tenant.table('tenants', {
  id: text('id').primaryKey(),                                    // TenantId 'tnt_...'
  tenantId: text('tenant_id').notNull(),                          // self-referencing (tenant_id = id)
  slug: text('slug').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status').notNull().$type<'active'|'suspended'|'trial'|'archived'>(),
  dataResidency: text('data_residency').notNull().$type<'us'|'eu'|'apac'>(),
  features: jsonb('features').notNull().default({}),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  tenantIdIdx: index('tenants_tenant_id_idx').on(t.tenantId),
  slugUq: uniqueIndex('tenants_slug_uq').on(t.slug),
}));

/* ------------------------------------------------------------------ *
 * tenant.workspaces — durable anchor for a WorkspaceContext (tenant-contracts.md).
 * ------------------------------------------------------------------ */
export const workspaces = tenant.table('workspaces', {
  workspaceId: text('workspace_id').primaryKey(),          // WorkspaceId 'wsp_...'
  tenantId: text('tenant_id').notNull(),
  conversationId: text('conversation_id'),                  // FK runtime.conversations, nullable until resolved
  channel: text('channel').notNull().$type<'sms'|'whatsapp'|'webchat'|'email'|'voice'|'api'>(),
  principalId: text('principal_id'),                        // FK tenant.users, initiating principal
  deploymentId: text('deployment_id'),                       // informational pin snapshot at creation
  status: text('status').notNull().$type<'active'|'closed'>().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ *
 * tenant.users — backs Principal (user|service|system at rest; agent principals never persisted).
 * ------------------------------------------------------------------ */
export const users = tenant.table('users', {
  principalId: text('principal_id').primaryKey(),           // PrincipalId 'prn_...'
  tenantId: text('tenant_id').notNull(),
  kind: text('kind').notNull().$type<'user'|'service'|'system'>(),
  displayName: text('display_name'),
  email: text('email'),
  authProvider: text('auth_provider').$type<'oidc'|'oauth2'|'api-key'|'signed-webhook'|'service-identity'>(),
  authSubject: text('auth_subject'),                         // external IdP subject
  externalHandle: text('external_handle'),                   // channel-derived identity (phone/email/session id)
  roleNames: text('role_names').array().notNull().default([]), // Principal.roles — resolves via tenant.roles
  attributes: jsonb('attributes').notNull().default({}),
  status: text('status').notNull().$type<'active'|'suspended'>().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastAuthenticatedAt: timestamp('last_authenticated_at', { withTimezone: true }),
}, t => ({
  tenantIdx: index('users_tenant_id_idx').on(t.tenantId),
  tenantKindIdx: index('users_tenant_kind_idx').on(t.tenantId, t.kind),
  authIdentityUq: uniqueIndex('users_tenant_auth_identity_uq').on(t.tenantId, t.authProvider, t.authSubject),
  externalHandleUq: uniqueIndex('users_tenant_external_handle_uq').on(t.tenantId, t.externalHandle),
  emailUq: uniqueIndex('users_tenant_email_uq').on(t.tenantId, t.email),
}));

/* ------------------------------------------------------------------ *
 * tenant.roles — role→scope resolution. tenant_id IS NULL = platform-defined role.
 * ------------------------------------------------------------------ */
export const roles = tenant.table('roles', {
  roleId: text('role_id').primaryKey(),                      // 'rol_...'
  tenantId: text('tenant_id'),                                // NULL = platform-defined
  name: text('name').notNull(),
  scopes: text('scopes').array().notNull().default([]),       // Scope[]
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  tenantNameUq: uniqueIndex('roles_tenant_name_uq').on(t.tenantId, t.name),
}));

/* ------------------------------------------------------------------ *
 * tenant.vertical_pack_installations — which vertical pack a tenant installed (ADR-013).
 * ------------------------------------------------------------------ */
export const verticalPackInstallations = tenant.table('vertical_pack_installations', {
  installationId: text('installation_id').primaryKey(),      // 'vpi_...'
  tenantId: text('tenant_id').notNull(),
  packId: text('pack_id').notNull(),                          // e.g. 'electrician'
  packVersion: text('pack_version').notNull(),                // SemVer
  status: text('status').notNull().$type<'installing'|'active'|'disabled'|'failed'>(),
  installedDefinitions: jsonb('installed_definitions').notNull().default([]), // {kind, definitionId, version}[]
  config: jsonb('config').notNull().default({}),               // tenant-tuned pack params
  installedBy: text('installed_by').notNull(),                 // PrincipalId
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  tenantPackUq: uniqueIndex('vpi_tenant_pack_uq').on(t.tenantId, t.packId),
}));
