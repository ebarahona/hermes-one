// Table DDL for the six-table content-addressed compiled-plan store (ADR-014/016/022).
// No new value types are declared here — rows are mapped to/from @platform/contracts by the
// repository adapter, never returned as raw Drizzle rows.
import {
  pgSchema,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

export const substrate = pgSchema('substrate'); // new core schema alongside the existing schemas

/* ------------------------------------------------------------------ *
 * definitions — one row per DefinitionId. The mutable "current version"
 * pointer; the authoring identity, never content-addressed itself.
 * ------------------------------------------------------------------ */
export const definitions = substrate.table(
  'definitions',
  {
    definitionId: text('definition_id').primaryKey(), // 'def_...'
    tenantId: text('tenant_id'), // NULL == platform-owned (DefinitionMeta)
    kind: text('kind')
      .notNull()
      .$type<'workflow' | 'rule' | 'policy' | 'capability' | 'agent-engine'>(),
    name: text('name').notNull(), // the `<name>` in schemaRef
    schemaRef: text('schema_ref').notNull(), // '<name>.<type>/vN' grammar
    currentVersion: text('current_version').notNull(), // SemVer of the latest published version
    status: text('status')
      .notNull()
      .$type<
        | 'draft'
        | 'validated'
        | 'compiled'
        | 'published'
        | 'deployed'
        | 'retired'
      >(),
    labels: jsonb('labels').notNull().default({}),
    createdAt: timestamp('created_at', {withTimezone: true})
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', {withTimezone: true})
      .notNull()
      .defaultNow(),
    createdBy: text('created_by').notNull(), // 'prn_...'
  },
  t => ({
    tenantIdx: index('definitions_tenant_id_idx').on(t.tenantId),
    kindIdx: index('definitions_kind_idx').on(t.kind),
    nameSchemaRefIdx: uniqueIndex('definitions_tenant_name_kind_uq').on(
      t.tenantId,
      t.name,
      t.kind,
    ), // one identity per (tenant, name, kind)
  }),
);

/* ------------------------------------------------------------------ *
 * definition_versions — one row per (definitionId, version). Immutable
 * once inserted. Points at the content-addressed artifact it produced.
 * ------------------------------------------------------------------ */
export const definitionVersions = substrate.table(
  'definition_versions',
  {
    definitionId: text('definition_id')
      .notNull()
      .references(() => definitions.definitionId),
    version: text('version').notNull(), // SemVer
    contentHash: text('content_hash').notNull(), // 'sha256:<64 hex>' — FK, not owned here
    family: text('family').notNull().$type<'logic-dsl' | 'contract-schema'>(),
    status: text('status')
      .notNull()
      .$type<'validated' | 'compiled' | 'published' | 'deployed' | 'retired'>(),
    body: jsonb('body').notNull(), // the authored Definition.body (audit trail)
    compilerVersion: text('compiler_version'), // NULL for contract-schema
    diagnostics: jsonb('diagnostics').notNull().default([]), // CompileDiagnostic[] at publish time
    createdAt: timestamp('created_at', {withTimezone: true})
      .notNull()
      .defaultNow(),
    createdBy: text('created_by').notNull(),
  },
  t => ({
    pk: primaryKey({columns: [t.definitionId, t.version]}),
    contentHashIdx: index('definition_versions_content_hash_idx').on(
      t.contentHash,
    ),
  }),
);

/* ------------------------------------------------------------------ *
 * compiled_plans — one row per contentHash. logic-dsl family only
 * (workflow | rule | policy). Insert-only, ON CONFLICT DO NOTHING.
 * ------------------------------------------------------------------ */
export const compiledPlans = substrate.table(
  'compiled_plans',
  {
    contentHash: text('content_hash').primaryKey(), // 'sha256:<64 hex>'
    planId: text('plan_id').notNull().unique(), // 'pln_...' — assigned once per contentHash
    definitionId: text('definition_id')
      .notNull()
      .references(() => definitions.definitionId),
    kind: text('kind').notNull().$type<'workflow' | 'rule' | 'policy'>(),
    version: text('version').notNull(), // SemVer of the definition version that produced this
    compilerVersion: text('compiler_version').notNull(), // pinned for replay determinism (ADR-014)
    planBody: jsonb('plan_body').notNull(), // CompiledPlanBase subtype, minus volatile fields
    byteSize: integer('byte_size').notNull(), // JCS(planBody).length — enforced ≤ maxCompiledPlanBytes
    compiledAt: timestamp('compiled_at', {withTimezone: true})
      .notNull()
      .defaultNow(),
  },
  t => ({
    definitionIdx: index('compiled_plans_definition_id_idx').on(t.definitionId),
    kindIdx: index('compiled_plans_kind_idx').on(t.kind),
  }),
);

/* ------------------------------------------------------------------ *
 * validated_contracts — one row per contentHash. contract-schema
 * family only (capability | agent-engine). No compiler, no planId.
 * ------------------------------------------------------------------ */
export const validatedContracts = substrate.table(
  'validated_contracts',
  {
    contentHash: text('content_hash').primaryKey(),
    definitionId: text('definition_id')
      .notNull()
      .references(() => definitions.definitionId),
    kind: text('kind').notNull().$type<'capability' | 'agent-engine'>(),
    version: text('version').notNull(),
    schemaRef: text('schema_ref').notNull(),
    contractBody: jsonb('contract_body').notNull(), // ValidatedContractBase subtype
    validatedAt: timestamp('validated_at', {withTimezone: true})
      .notNull()
      .defaultNow(),
  },
  t => ({
    definitionIdx: index('validated_contracts_definition_id_idx').on(
      t.definitionId,
    ),
    kindIdx: index('validated_contracts_kind_idx').on(t.kind),
  }),
);

/* ------------------------------------------------------------------ *
 * deployments — one row per DeploymentId. version is per-tenant
 * monotonic. Immutable once inserted; only
 * `status` transitions (active → superseded | rolledback).
 * ------------------------------------------------------------------ */
export const deployments = substrate.table(
  'deployments',
  {
    deploymentId: text('deployment_id').primaryKey(), // 'dpl_...'
    tenantId: text('tenant_id').notNull(),
    version: text('version').notNull(), // SemVer, monotonic per tenant
    status: text('status')
      .notNull()
      .$type<'active' | 'superseded' | 'rolledback'>(),
    operatorRegistryVersion: text('operator_registry_version').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', {withTimezone: true})
      .notNull()
      .defaultNow(),
    createdBy: text('created_by').notNull(),
  },
  t => ({
    tenantVersionUq: uniqueIndex('deployments_tenant_version_uq').on(
      t.tenantId,
      t.version,
    ),
    // Enforced as a partial unique index in the drizzle-kit migration (not expressible in table DSL):
    //   CREATE UNIQUE INDEX deployments_tenant_active_uq ON substrate.deployments (tenant_id)
    //   WHERE status = 'active';
    tenantStatusIdx: index('deployments_tenant_status_idx').on(
      t.tenantId,
      t.status,
    ),
  }),
);

/* ------------------------------------------------------------------ *
 * deployment_members — one row per (deploymentId, kind, seq). seq is
 * always 0 for the singleton kinds (workflow/agentEngine/policy) and
 * 0..N-1 for the array kinds (rules/capabilities), preserving
 * DeploymentMember order for reconstruction.
 * ------------------------------------------------------------------ */
export const deploymentMembers = substrate.table(
  'deployment_members',
  {
    deploymentId: text('deployment_id')
      .notNull()
      .references(() => deployments.deploymentId),
    kind: text('kind')
      .notNull()
      .$type<'workflow' | 'agent-engine' | 'policy' | 'rule' | 'capability'>(),
    seq: integer('seq').notNull().default(0), // ordering within rules[] / capabilities[]
    definitionId: text('definition_id').notNull(),
    planId: text('plan_id'), // NULL for capability/agent-engine (ADR-016)
    version: text('version').notNull(),
    contentHash: text('content_hash').notNull(),
  },
  t => ({
    pk: primaryKey({columns: [t.deploymentId, t.kind, t.seq]}),
    contentHashIdx: index('deployment_members_content_hash_idx').on(
      t.contentHash,
    ),
  }),
);
