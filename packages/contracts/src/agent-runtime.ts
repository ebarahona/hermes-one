// Agent-turn contracts. The rich ToolResult envelope is synthesized
// AROUND agentback's unwrapped result (ADR-018); the platform owns a single-step
// loop (ADR-021). Every field is JSON-serializable (Temporal activity I/O).
import {z} from 'zod';
import {CapabilityName, ChangedDomain, SideEffectClass} from './capability.js';
import {
  ContentHash,
  DefinitionId,
  EvidenceId,
  IsoTimestamp,
  SemVer,
  ToolCallId,
  TurnId,
  ValidatedContractBase,
} from './substrate.js';
import {WorkspaceContext} from './tenant.js';
import {PolicyDecision} from './policy.js';

export {EvidenceId, IsoTimestamp, ToolCallId, TurnId};

/* --------------------------- Agent-engine config ----------------------- */
// Contract-schema family (ADR-016): validated config, no compiler. References rules/capabilities by name.

export const AgentEngineBody = z.object({
  persona: z.string().min(1), // no business logic; tone/role only
  objectives: z.array(z.string().min(1)).min(1),
  /** Capabilities the engine may propose (by name). Visibility still gated by scope + policy. */
  allowedCapabilities: z.array(CapabilityName),
  /** Rules the engine/workflow may consult by name (rules decide, engine does not). */
  referencedRules: z.array(z.string()).default([]),
  model: z.object({
    provider: z.string(), // e.g. "anthropic" — substrate is single-step (ADR-021)
    model: z.string(),
    temperature: z.number().min(0).max(2).default(0),
  }),
  /** Prompt template ids resolved from the template store (data, not files — ADR-013). */
  promptTemplateIds: z.array(z.string()).default([]),
});
export type AgentEngineBody = z.infer<typeof AgentEngineBody>;

export const AgentEngineContract = ValidatedContractBase.extend({
  kind: z.literal('agent-engine'),
  body: AgentEngineBody,
});
export type AgentEngineContract = z.infer<typeof AgentEngineContract>;

/* ------------------------------ TurnRequest ---------------------------- */

/** The workflow-set objective for a bounded agent turn. */
export const TurnObjective = z.string().min(1);
export type TurnObjective = z.infer<typeof TurnObjective>;

export const TurnRequest = z.object({
  turnId: TurnId,
  workspace: WorkspaceContext, // carries tenantRuntime + principal (serializable)
  agentEngine: z.object({
    definitionId: DefinitionId,
    version: SemVer,
    contentHash: ContentHash,
  }),
  /** The inbound stimulus for this turn. */
  inbound: z.object({
    text: z.string().optional(),
    attachments: z
      .array(z.object({kind: z.string(), ref: z.string()}))
      .default([]),
  }),
  /** Objective the workflow set for this turn (bounded reasoning). */
  objective: TurnObjective,
});
export type TurnRequest = z.infer<typeof TurnRequest>;

/* ------------------------------ TurnContext ---------------------------- */
// Assembled inside the activity; NOT sent over the wire beyond the request above.

export const TurnContext = z.object({
  turnId: TurnId,
  workspace: WorkspaceContext,
  step: z.number().int().nonnegative(),
  /** Evidence accumulated so far — the ONLY grounding the composer may use (ADR-009). */
  evidence: z.array(z.lazy(() => EvidenceRecord)),
  /** Domains changed so far this turn — drives selective refresh. */
  dirtyDomains: z.array(ChangedDomain),
  startedAt: IsoTimestamp,
  deadlineAt: IsoTimestamp,
});
export type TurnContext = z.infer<typeof TurnContext>;

/* ------------------------------- ToolCall ------------------------------ */

/** A single-step model proposal to invoke one capability (ADR-021: propose → gate → execute). */
export const ToolCall = z.object({
  toolCallId: ToolCallId,
  capability: CapabilityName,
  input: z.record(z.string(), z.unknown()),
  /** Idempotency key derived by the executor from the capability IdempotencySpec. */
  idempotencyKey: z.string().min(1),
  proposedAt: IsoTimestamp,
});
export type ToolCall = z.infer<typeof ToolCall>;

/* ---------------------------- EvidenceRecord --------------------------- */

export const EvidenceKind = z.enum([
  'tool-output',
  'authoritative-read',
  'retrieval',
  'system',
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/** A grounded, citable fact (evidence-only composition, ADR-009). */
export const EvidenceRecord = z.object({
  id: EvidenceId,
  turnId: TurnId,
  toolCallId: ToolCallId.nullable(),
  kind: EvidenceKind,
  capability: CapabilityName.nullable(),
  statement: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  /** Provenance — untrusted-content handling (indirect-injection defense). */
  source: z.enum(['authoritative', 'provider', 'retrieved', 'system']),
  trusted: z.boolean(),
  observedAt: IsoTimestamp,
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;

/* ------------------------------ ToolResult ----------------------------- */

export const ToolMetrics = z.object({
  latencyMs: z.number().nonnegative(),
  providerId: z.string().optional(),
  retries: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  /** true if agentback replayed a prior result. */
  idempotentReplay: z.boolean().default(false),
});
export type ToolMetrics = z.infer<typeof ToolMetrics>;

/**
 * The rich platform envelope synthesized AROUND agentback's unwrapped result
 * (ADR-018). `output` is agentback's output-validated value; `sideEffect`/
 * `changedDomains`/`stateChanged` come from capability metadata;
 * `evidence`/`metrics` come from the dispatch hook.
 */
export const ToolResult = z.object({
  toolCallId: ToolCallId,
  capability: CapabilityName,
  ok: z.boolean(),
  output: z.unknown(),
  sideEffect: SideEffectClass,
  stateChanged: z.boolean(),
  changedDomains: z.array(ChangedDomain),
  evidence: z.array(EvidenceRecord),
  metrics: ToolMetrics,
  /** Present when ok=false — maps to error-contracts.PlatformError. */
  error: z
    .object({code: z.string(), message: z.string(), retryable: z.boolean()})
    .nullable(),
});
export type ToolResult = z.infer<typeof ToolResult>;

/* ------------------------------ TurnResult ----------------------------- */

export const TurnResult = z.object({
  turnId: TurnId,
  outcome: z.enum(['replied', 'handoff', 'deferred', 'no-action', 'failed']),
  /** Composed, post-gated reply text (present when outcome=replied). */
  reply: z.string().optional(),
  /** If a gate stopped the turn, the decision that did so. */
  gateDecision: PolicyDecision.nullable(),
  toolCalls: z.array(ToolCall),
  evidence: z.array(EvidenceRecord),
  steps: z.number().int().nonnegative(),
  metrics: z.object({
    modelCostUsd: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    toolCount: z.number().int().nonnegative(),
  }),
  finishedAt: IsoTimestamp,
});
export type TurnResult = z.infer<typeof TurnResult>;

/* ---------------------------- Executor port ---------------------------- */

/** Wraps agentback invokeTool; synthesizes ToolResult (ADR-018). Platform-owned. */
export interface ToolExecutor {
  execute(call: ToolCall, ctx: TurnContext): Promise<ToolResult>;
}
