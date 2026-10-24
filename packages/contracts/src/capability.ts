// Capability vocabulary (subset). Zod-first (ADR-020). Canonical enum values —
// do not invent; new values are a capability-contract change, not an ad-hoc add.
import {z} from 'zod';
import {DefinitionId, SemVer, ValidatedContractBase} from './substrate.js';
import {Scope} from './tenant.js';
import {RuleExpression} from './rule.js';

/* ------------------------------ Naming --------------------------------- */

/** Provider-neutral capability name: `domain.resource.action`. */
export const CapabilityName = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/,
    'expected "domain.resource.action"',
  )
  .brand('CapabilityName');
export type CapabilityName = z.infer<typeof CapabilityName>;

/* --------------------------- Side-effect class ------------------------- */

/** Side-effect class of a capability. */
export const SideEffectClass = z.enum([
  'none', // pure compute (e.g. classify)
  'read', // reads external state, no mutation (idempotent by nature)
  'write', // idempotent mutation (requires idempotencyKey)
  'external', // non-idempotent external effect (message send, third-party call)
  'payment', // money movement (external + payment gate / 402)
]);
export type SideEffectClass = z.infer<typeof SideEffectClass>;

/**
 * Domains the platform core names. `'none'` means the capability changes no business state. A pack
 * may declare any other domain (ADR-013, ADR-030); these constants document the core vocabulary.
 */
export const KNOWN_CHANGED_DOMAINS = [
  'appointment',
  'contact',
  'conversation',
  'payment',
  'knowledge',
  'messaging',
  'none',
] as const;

/**
 * Business-state domain a capability may change — drives selective refresh + ToolResult (ADR-018).
 * Open string (ADR-030): a known value or any pack-declared lowercase identifier.
 */
export const ChangedDomain = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, 'expected a lowercase domain identifier');
export type ChangedDomain = z.infer<typeof ChangedDomain>;

/* --------------------------- Idempotency spec -------------------------- */

/** How the executor derives the idempotency key for a write/external/payment capability. */
export const IdempotencySpec = z.object({
  required: z.boolean(),
  /** Input field paths whose values form the key (plus turnId + capability name). */
  keyFields: z.array(z.string()).default([]),
  /** TTL for the dedupe record in Redis (ephemeral) — canonical replay store is durable per ADR-018. */
  ttlSeconds: z.number().int().positive().default(86_400),
});
export type IdempotencySpec = z.infer<typeof IdempotencySpec>;

/* --------------------------- Provider mapping -------------------------- */

export const ProviderRef = z.object({
  providerId: z.string().min(1), // e.g. "twilio", "sendgrid"
  /** Higher wins. tenant override > vertical default > platform default. */
  priority: z.number().int(),
  /** Optional per-provider config key set (secrets resolved at runtime, never here). */
  configKey: z.string().optional(),
});
export type ProviderRef = z.infer<typeof ProviderRef>;

export const EligibilityRule = z.object({
  /** Shared expression over tenantRuntime facts (feature flags, residency, consent). */
  when: RuleExpression,
  /** If `when` is false the provider is ineligible for this request. */
  reason: z.string().max(200),
});
export type EligibilityRule = z.infer<typeof EligibilityRule>;

export const ProviderMapping = z.object({
  providers: z.array(ProviderRef).min(1),
  eligibility: z.array(EligibilityRule).default([]),
  /** Behavior when all providers are unhealthy/ineligible. */
  onNoProvider: z.enum(['fail', 'handoff']).default('fail'),
});
export type ProviderMapping = z.infer<typeof ProviderMapping>;

/* --------------------- The capability contract body -------------------- */

/**
 * Zod-first (ADR-020). `input`/`output` are Zod schemas at authoring time; the stored/serialized form
 * carries the JSON Schema generated from them (`inputJsonSchema`/`outputJsonSchema`). Both are shown so
 * the contract is complete for a serialized registry entry.
 */
export interface Capability<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: CapabilityName;
  version: SemVer;
  title: string;
  description: string;
  input: I; // Zod source of truth
  output: O; // Zod source of truth
  sideEffect: SideEffectClass;
  changedDomains: ChangedDomain[]; // metadata for ADR-018 envelope + selective refresh
  idempotency: IdempotencySpec;
  /** agentback `confirm:` — side-effecting/approval tools require confirm (ADR-021/T8). */
  confirm: boolean;
  /** Scope required to see/dispatch this tool (ADR-019 visibility). */
  requiredScope: Scope;
  providerMapping: ProviderMapping;
}

/** Serialized registry entry (JSON-safe): Zod replaced by generated JSON Schema. */
export const CapabilityContract = ValidatedContractBase.extend({
  kind: z.literal('capability'),
  name: CapabilityName,
  title: z.string().min(1),
  description: z.string().min(1),
  inputJsonSchema: z.record(z.string(), z.unknown()), // generated FROM Zod (ADR-020)
  outputJsonSchema: z.record(z.string(), z.unknown()),
  sideEffect: SideEffectClass,
  changedDomains: z.array(ChangedDomain),
  idempotency: IdempotencySpec,
  confirm: z.boolean(),
  requiredScope: Scope,
  providerMapping: ProviderMapping,
});
export type CapabilityContract = z.infer<typeof CapabilityContract>;

/* --------------------------- Manifest (pinned) ------------------------- */

export const CapabilityManifest = z.object({
  entries: z.array(
    z.object({
      definitionId: DefinitionId,
      name: CapabilityName,
      version: SemVer,
    }),
  ),
});
export type CapabilityManifest = z.infer<typeof CapabilityManifest>;

/** Registry port — validate/register/resolve (no compiler — ADR-016). */
export interface CapabilityRegistry {
  register(cap: CapabilityContract): Promise<void>;
  get(
    name: CapabilityName,
    version: SemVer,
  ): Promise<CapabilityContract | null>;
  list(manifest: CapabilityManifest): Promise<CapabilityContract[]>;
}
