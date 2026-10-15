// @platform/contracts — src/tenant.ts
import {z} from 'zod';
import {
  TenantId,
  WorkspaceId,
  ConversationId,
  PrincipalId,
  IsoTimestamp,
  DeploymentRef,
  SemVer,
} from './substrate.js';

/* ------------------------------ Principal ------------------------------ */

export const PrincipalKind = z.enum(['user', 'agent', 'system', 'service']);
export type PrincipalKind = z.infer<typeof PrincipalKind>;

/** A capability scope string; mirrors capability naming `domain.resource.action` (+ wildcards). */
export const Scope = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*(\.[a-z0-9*-]+){1,2}$/,
    'expected "domain.resource.action" scope',
  )
  .brand('Scope');
export type Scope = z.infer<typeof Scope>;

export const Principal = z.object({
  id: PrincipalId,
  tenantId: TenantId,
  kind: PrincipalKind,
  displayName: z.string().max(200).optional(),
  /** Roles resolve to scopes; scopes are the enforcement primitive (ADR-019). */
  roles: z.array(z.string().min(1)).default([]),
  /** Flattened, resolved scopes. Drives agentback tools/list visibility + voters. */
  scopes: z.array(Scope).default([]),
  /** ABAC attributes consumed by policy voters (department, region, consent flags, …). */
  attributes: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .default({}),
});
export type Principal = z.infer<typeof Principal>;

/* --------------------------- TenantContext ----------------------------- */

export const TenantStatus = z.enum([
  'active',
  'suspended',
  'trial',
  'archived',
]);
export type TenantStatus = z.infer<typeof TenantStatus>;

export const DataResidency = z.enum(['us', 'eu', 'apac']);
export type DataResidency = z.infer<typeof DataResidency>;

/** Static tenant facts. Cacheable; changes are rare and audited. */
export const TenantContext = z.object({
  tenantId: TenantId,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  displayName: z.string().max(200),
  status: TenantStatus,
  dataResidency: DataResidency,
  /** Feature flags gate platform capabilities, never business logic (no logic in flags). */
  features: z.record(z.string(), z.boolean()).default({}),
  createdAt: IsoTimestamp,
});
export type TenantContext = z.infer<typeof TenantContext>;

/* ----------------------- Quota / budget envelope ----------------------- */

export const QuotaProfile = z.object({
  profileId: z.string().min(1),
  /** Ceilings enforced at the turn pre-gate. Null == unlimited (platform-tier only). */
  maxModelCostUsdPerDay: z.number().nonnegative().nullable(),
  maxTokensPerDay: z.number().int().nonnegative().nullable(),
  maxTurnsPerConversation: z.number().int().positive().nullable(),
  maxMessagesPerDay: z.number().int().nonnegative().nullable(),
});
export type QuotaProfile = z.infer<typeof QuotaProfile>;

/** Per-turn bounds (steps/deadline/budget). Unified vocabulary (findings workflow #5). */
export const TurnBudgets = z.object({
  maxSteps: z.number().int().positive().default(8),
  deadlineMs: z.number().int().positive().default(120_000),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxModelCostUsd: z.number().nonnegative(),
});
export type TurnBudgets = z.infer<typeof TurnBudgets>;

/* ------------------------ TenantRuntimeContext ------------------------- */

/** The value bound per request/turn: static tenant facts + resolved runtime envelope. */
export const TenantRuntimeContext = z.object({
  tenant: TenantContext,
  /** Convenience mirror of tenant.tenantId for hot paths + `SET LOCAL app.tenant_id`. */
  tenantId: TenantId,
  /** The immutable deployment every decision pins to (ADR-014/016). */
  deployment: DeploymentRef,
  quotaProfile: QuotaProfile,
  budgets: TurnBudgets,
  locale: z.string().default('en-US'), // BCP-47
  timezone: z.string().default('UTC'), // IANA; also the rule-runtime "now" source zone
  operatorRegistryVersion: SemVer, // mirrored from deployment for the rule/policy runtimes
});
export type TenantRuntimeContext = z.infer<typeof TenantRuntimeContext>;

/* --------------------------- WorkspaceContext -------------------------- */

export const Channel = z.enum([
  'sms',
  'whatsapp',
  'webchat',
  'email',
  'voice',
  'api',
]);
export type Channel = z.infer<typeof Channel>;

/**
 * The conversation/channel-scoped envelope carried into a workflow and each turn.
 * This is the object serialized across the Temporal-activity boundary (ADR-017).
 */
export const WorkspaceContext = z.object({
  workspaceId: WorkspaceId,
  tenantRuntime: TenantRuntimeContext,
  principal: Principal,
  conversationId: ConversationId.nullable(),
  channel: Channel,
  /** Correlates edge, workflow, turn, and metering (correlationId = turnId at turn scope). */
  correlationId: z.string().min(1),
});
export type WorkspaceContext = z.infer<typeof WorkspaceContext>;

/* ------------------ Agentback principal value-mapper ------------------ */

/** Shape the value-mapper (ADR-017) produces; agentback binds this as its TRANSIENT principal. */
export const AgentbackPrincipal = z.object({
  subject: PrincipalId,
  tenantId: TenantId,
  kind: PrincipalKind,
  scopes: z.array(Scope),
  attributes: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
});
export type AgentbackPrincipal = z.infer<typeof AgentbackPrincipal>;

/** Pure mapping — the "bridge" is a value-mapper, NOT DI marshalling (ADR-017). */
export function principalFromWorkspace(
  ws: WorkspaceContext,
): AgentbackPrincipal {
  return {
    subject: ws.principal.id,
    tenantId: ws.tenantRuntime.tenantId,
    kind: ws.principal.kind,
    scopes: ws.principal.scopes,
    attributes: ws.principal.attributes,
  };
}
