// @hermes-one/contracts — src/policy.ts
import {z} from 'zod';
import {
  DefinitionId,
  SemVer,
  IsoTimestamp,
  CompiledPlanBase,
} from './substrate.js';
import {RuleExpression, RuleParameterDecl} from './rule.js';
import {Principal, Scope} from './tenant.js';

/* --------------------------- Decision vocabulary ----------------------- */

/** The six policy outcomes (ADR-019). Superset of the voter verdict. */
export const PolicyOutcome = z.enum([
  'allow',
  'deny',
  'defer', // not now — retry later / wait (e.g. quiet hours)
  'repair', // reply must be bounded-repaired before delivery (post-gate)
  'handoff', // route to a human (workflow handoff outcome)
  'approval', // requires explicit human/step-up approval before proceeding
]);
export type PolicyOutcome = z.infer<typeof PolicyOutcome>;

/** The dispatch-time voter verdict agentback understands (ADR-019). */
export const VoterVerdict = z.enum(['allow', 'deny', 'abstain']);
export type VoterVerdict = z.infer<typeof VoterVerdict>;

export const PolicyDecision = z.object({
  outcome: PolicyOutcome,
  /** Which policy rule produced this (audit + admin explainability). */
  policyRuleId: z.string().min(1),
  reason: z.string().max(500),
  /** For defer: when to retry. For approval: what approval is needed. */
  detail: z
    .object({
      retryAfterMs: z.number().int().positive().optional(),
      approvalKind: z.string().optional(),
      repairInstruction: z.string().optional(),
    })
    .partial()
    .optional(),
  decidedAt: IsoTimestamp,
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;

/* ----------------------------- Binding sites --------------------------- */

export const PolicySite = z.enum(['voter', 'preGate', 'postGate']);
export type PolicySite = z.infer<typeof PolicySite>;

/** A single policy rule: condition (shared expression) → effect, bound at a site. */
export const PolicyRule = z.object({
  id: z.string().min(1),
  site: PolicySite,
  /** For voter rules: which tools/scopes this governs (capability names / scope globs). */
  appliesTo: z.array(z.string()).default([]), // e.g. ["appointment.booking.create", "*.write"]
  when: RuleExpression, // shared expression core (ADR-016)
  /** Effect when `when` is true. Voter rules must use allow/deny only. */
  effect: PolicyOutcome,
  reason: z.string().max(500),
  detail: z
    .object({
      retryAfterMs: z.number().int().positive().optional(),
      approvalKind: z.string().optional(),
      repairInstruction: z.string().optional(),
    })
    .partial()
    .optional(),
});
export type PolicyRule = z.infer<typeof PolicyRule>;

export const PolicyDefinitionBody = z.object({
  rules: z.array(PolicyRule).min(1),
  /** Default when no rule is definitive. Platform invariant: default-DENY at the voter site. */
  defaultVoterVerdict: z.literal('deny').default('deny'),
  parameters: z.array(RuleParameterDecl).default([]),
});
export type PolicyDefinitionBody = z.infer<typeof PolicyDefinitionBody>;

export const PolicyDefinition = z.object({
  definitionId: DefinitionId,
  kind: z.literal('policy'),
  version: SemVer,
  body: PolicyDefinitionBody,
});
export type PolicyDefinition = z.infer<typeof PolicyDefinition>;

/* ---------------------------- Compiled plan ---------------------------- */

export type CompiledVoter = z.infer<typeof CompiledVoter>;
export const CompiledVoter = z.object({
  policyRuleId: z.string(),
  appliesTo: z.array(z.string()),
  when: RuleExpression,
  verdict: VoterVerdict, // allow|deny only at voter site
  reason: z.string(),
});

export const CompiledGate = z.object({
  policyRuleId: z.string(),
  when: RuleExpression,
  outcome: PolicyOutcome,
  reason: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

export const CompiledPolicyPlan = CompiledPlanBase.extend({
  kind: z.literal('policy'),
  voters: z.array(CompiledVoter),
  preGates: z.array(CompiledGate),
  postGates: z.array(CompiledGate),
  defaultVoterVerdict: z.literal('deny'),
  parameters: z.array(RuleParameterDecl),
  operatorRefs: z.array(z.object({op: z.string(), version: SemVer})),
});
export type CompiledPolicyPlan = z.infer<typeof CompiledPolicyPlan>;

/* --------------------------- Evaluation context ------------------------ */

export const PolicyEvaluationContext = z.object({
  principal: Principal,
  /** Facts for the shared expressions (consent, hours, budgetRemaining, tool name, draft reply, …). */
  facts: z.record(z.string(), z.unknown()),
  now: IsoTimestamp,
  parameters: z.record(z.string(), z.unknown()).default({}),
  /** Present only at postGate: the composed draft reply being screened. */
  draftReply: z.string().optional(),
  /** Present only at voter site: the tool/capability being dispatched + caller scopes. */
  capability: z.string().optional(),
  scopes: z.array(Scope).optional(),
});
export type PolicyEvaluationContext = z.infer<typeof PolicyEvaluationContext>;

/** The Policy Engine authors/compiles; agentback enforces voters. This port is the compile+screen surface. */
export interface PolicyRuntime {
  /** Pre-gate turn-level screen. */
  evaluatePreGates(
    plan: CompiledPolicyPlan,
    ctx: PolicyEvaluationContext,
  ): PolicyDecision;
  /** Post-gate reply screen (returns allow/deny/repair). */
  evaluatePostGates(
    plan: CompiledPolicyPlan,
    ctx: PolicyEvaluationContext,
  ): PolicyDecision;
  /** Project voters for agentback @authorize binding (enforcement is agentback's, ADR-019). */
  toVoters(plan: CompiledPolicyPlan): CompiledVoter[];
}
