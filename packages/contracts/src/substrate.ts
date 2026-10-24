// @hermes-one/contracts — src/substrate.ts
// Definition-substrate primitives (ADR-016): branded ids, primitive value
// contracts, the Definition envelope, the CompiledPlan base every logic DSL
// extends, and the immutable Deployment manifest. Zod-first.
import {z} from 'zod';

/* ------------------------------------------------------------------ *
 * Branded identifiers — one canonical definition for the whole repo.
 * ------------------------------------------------------------------ */
const branded = <B extends string>(prefix: string, brand: B) =>
  z
    .string()
    .min(prefix.length + 1)
    .startsWith(`${prefix}_`)
    .brand(brand);

export const TenantId = branded('tnt', 'TenantId');
export const WorkspaceId = branded('wsp', 'WorkspaceId');
export const ConversationId = branded('cnv', 'ConversationId');
export const PrincipalId = branded('prn', 'PrincipalId');
export const DefinitionId = branded('def', 'DefinitionId');
export const PlanId = branded('pln', 'PlanId');
export const DeploymentId = branded('dpl', 'DeploymentId');
export const TurnId = branded('trn', 'TurnId');
export const ToolCallId = branded('tc', 'ToolCallId');
export const EvidenceId = branded('evd', 'EvidenceId');
export const HandoffId = branded('hof', 'HandoffId');
export const AuditEventId = branded('aud', 'AuditEventId');
export const UsageEventId = branded('usg', 'UsageEventId');

export type TenantId = z.infer<typeof TenantId>;
export type WorkspaceId = z.infer<typeof WorkspaceId>;
export type ConversationId = z.infer<typeof ConversationId>;
export type PrincipalId = z.infer<typeof PrincipalId>;
export type DefinitionId = z.infer<typeof DefinitionId>;
export type PlanId = z.infer<typeof PlanId>;
export type DeploymentId = z.infer<typeof DeploymentId>;
export type TurnId = z.infer<typeof TurnId>;
export type ToolCallId = z.infer<typeof ToolCallId>;
export type EvidenceId = z.infer<typeof EvidenceId>;
export type HandoffId = z.infer<typeof HandoffId>;
export type AuditEventId = z.infer<typeof AuditEventId>;
export type UsageEventId = z.infer<typeof UsageEventId>;

/* ------------------------------------------------------------------ *
 * Primitive value contracts.
 * ------------------------------------------------------------------ */

/** Content hash of the canonical (RFC 8785 JCS) JSON of a plan/contract. */
export const ContentHash = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected "sha256:<64 hex>"')
  .brand('ContentHash');
export type ContentHash = z.infer<typeof ContentHash>;

export const SemVer = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'expected semver')
  .brand('SemVer');
export type SemVer = z.infer<typeof SemVer>;

export const IsoTimestamp = z
  .string()
  .datetime({offset: true})
  .brand('IsoTimestamp');
export type IsoTimestamp = z.infer<typeof IsoTimestamp>;

/** `<name>.<type>/vN` — e.g. `intake.workflow/v3`, `dispatch.rule/v1`. ADR-016. */
export const SchemaRef = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*\.(workflow|rule|policy|capability|agent-engine)\/v\d+$/,
    'expected "<name>.<type>/vN"',
  )
  .brand('SchemaRef');
export type SchemaRef = z.infer<typeof SchemaRef>;

/* ------------------------------------------------------------------ *
 * Two-family taxonomy (ADR-016).
 * ------------------------------------------------------------------ */
export const DefinitionKind = z.enum([
  'workflow',
  'rule',
  'policy',
  'capability',
  'agent-engine',
]);
export type DefinitionKind = z.infer<typeof DefinitionKind>;

export const DefinitionFamily = z.enum(['logic-dsl', 'contract-schema']);
export type DefinitionFamily = z.infer<typeof DefinitionFamily>;

/** workflow/rule/policy compile; capability/agent-engine validate only. */
export const FAMILY_OF: Readonly<Record<DefinitionKind, DefinitionFamily>> = {
  workflow: 'logic-dsl',
  rule: 'logic-dsl',
  policy: 'logic-dsl',
  capability: 'contract-schema',
  'agent-engine': 'contract-schema',
} as const;

export const DefinitionStatus = z.enum([
  'draft',
  'validated',
  'compiled', // logic DSLs after successful compile
  'published', // immutable, eligible to be pinned
  'deployed', // referenced by at least one active Deployment
  'retired',
]);
export type DefinitionStatus = z.infer<typeof DefinitionStatus>;

/* ------------------------------------------------------------------ *
 * Definition envelope (authoring surface, all five kinds).
 * ------------------------------------------------------------------ */
export const DefinitionMeta = z.object({
  definitionId: DefinitionId,
  tenantId: TenantId.nullable(), // null == platform-owned (shared) definition
  kind: DefinitionKind,
  name: z.string().min(1).max(128), // the `<name>` in schemaRef
  schemaRef: SchemaRef,
  version: SemVer,
  status: DefinitionStatus,
  labels: z.record(z.string(), z.string()).default({}),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  createdBy: PrincipalId,
});
export type DefinitionMeta = z.infer<typeof DefinitionMeta>;

/**
 * Generic authoring envelope. `body` is refined by the per-type schema
 * (WorkflowDefinitionBody, RuleDefinitionBody, …). Kept as unknown here so the
 * substrate stays type-agnostic; specialized docs narrow it.
 */
export const Definition = DefinitionMeta.extend({
  body: z.unknown(),
});
export type Definition<Body = unknown> = z.infer<typeof DefinitionMeta> & {
  body: Body;
};

/* ------------------------------------------------------------------ *
 * Compiled artifacts.
 * ------------------------------------------------------------------ */

/** Base for every logic-DSL compiled plan. Extended by CompiledWorkflowPlan / CompiledRulePlan / CompiledPolicyPlan. */
export const CompiledPlanBase = z.object({
  planId: PlanId,
  definitionId: DefinitionId,
  kind: z.enum(['workflow', 'rule', 'policy']),
  version: SemVer,
  contentHash: ContentHash, // hash of the canonical compiled JSON (this object minus volatile fields)
  compilerVersion: SemVer, // pinned for replay determinism
  compiledAt: IsoTimestamp,
  // `graph`/`plan` body is added by the specializing schema.
});
export type CompiledPlanBase = z.infer<typeof CompiledPlanBase>;

/** Base for a validated (non-compiled) contract schema: capability, agent-engine. */
export const ValidatedContractBase = z.object({
  definitionId: DefinitionId,
  kind: z.enum(['capability', 'agent-engine']),
  version: SemVer,
  contentHash: ContentHash, // hash of the canonical contract JSON
  validatedAt: IsoTimestamp,
  schemaRef: SchemaRef,
});
export type ValidatedContractBase = z.infer<typeof ValidatedContractBase>;

/* ------------------------------------------------------------------ *
 * Deployment manifest — pins all five together (ADR-014, ADR-016).
 * ------------------------------------------------------------------ */
export const DeploymentMember = z.object({
  kind: DefinitionKind,
  definitionId: DefinitionId,
  planId: PlanId.nullable(), // null for contract schemas (validated, not compiled)
  version: SemVer,
  contentHash: ContentHash,
});
export type DeploymentMember = z.infer<typeof DeploymentMember>;

export const Deployment = z.object({
  deploymentId: DeploymentId,
  tenantId: TenantId,
  version: SemVer, // monotonically increasing per tenant
  status: z.enum(['active', 'superseded', 'rolledback']),
  // Exactly the five families of the substrate, each optionally many rules/capabilities.
  workflow: DeploymentMember, // the entry workflow
  agentEngine: DeploymentMember,
  policy: DeploymentMember,
  rules: z.array(DeploymentMember), // one rule-set may reference many rule definitions
  capabilities: z.array(DeploymentMember), // capability manifest
  operatorRegistryVersion: SemVer, // pins rule/policy/workflow operators (ADR-015)
  createdAt: IsoTimestamp,
  createdBy: PrincipalId,
  notes: z.string().max(2000).optional(),
});
export type Deployment = z.infer<typeof Deployment>;

/** The small pin Temporal start/signal payloads carry — never the full plan (ADR-014). */
export const DeploymentRef = z.object({
  deploymentId: DeploymentId,
  tenantId: TenantId,
  version: SemVer,
});
export type DeploymentRef = z.infer<typeof DeploymentRef>;
