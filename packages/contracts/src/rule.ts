// Rule definition substrate contracts (ADR-015). Rules are deterministic
// business decisions: authored as data, compiled to content-hashed plans,
// evaluated by ONE RuleRuntime. Only operators are code, and operators are PURE
// over provided facts (no I/O, no clock — time enters as `facts.now`). A rule
// returns an OUTCOME; it never orchestrates, waits, or causes side effects.
import {z} from 'zod';
import {
  CompiledPlanBase,
  DefinitionId,
  IsoTimestamp,
  SemVer,
} from './substrate.js';

/* --------------------- Shared expression core (ADR-016) ---------------- */
// One expression tree reused by workflow branch predicates, rules, and policy.

export type RuleExpression =
  | {type: 'literal'; value: unknown}
  | {type: 'fact'; path: string}
  | {type: 'param'; name: string}
  | {type: 'op'; op: string; args: RuleExpression[]}
  | {type: 'and'; all: RuleExpression[]}
  | {type: 'or'; any: RuleExpression[]}
  | {type: 'not'; expr: RuleExpression};

export const RuleExpression: z.ZodType<RuleExpression> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({type: z.literal('literal'), value: z.unknown()}),
    z.object({type: z.literal('fact'), path: z.string().min(1)}),
    z.object({type: z.literal('param'), name: z.string().min(1)}),
    z.object({
      type: z.literal('op'),
      op: z.string().min(1),
      args: z.array(RuleExpression),
    }),
    z.object({type: z.literal('and'), all: z.array(RuleExpression).min(1)}),
    z.object({type: z.literal('or'), any: z.array(RuleExpression).min(1)}),
    z.object({type: z.literal('not'), expr: RuleExpression}),
  ]),
);

/* ----------------------- Operator contract (code) ---------------------- */

/** LB4 discovery tag for operators (ADR-015). */
export const RULE_OPERATOR_EXTENSION_TYPE = 'rule.operator' as const;

export const RuleOperatorSpec = z.object({
  op: z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/),
  arity: z.union([z.number().int().nonnegative(), z.literal('variadic')]),
  version: SemVer,
  returns: z.enum(['boolean', 'number', 'string', 'unknown']),
  pure: z.literal(true), // operators are ALWAYS pure (ADR-015)
});
export type RuleOperatorSpec = z.infer<typeof RuleOperatorSpec>;

export const RuleFacts = z.record(z.string(), z.unknown());
export type RuleFacts = z.infer<typeof RuleFacts>;

/**
 * The operator implementation contract. PURE: no I/O, no Date.now(), no globals.
 * Time, business hours, service-area polygons, etc. arrive via `facts`/args.
 */
export interface RuleOperator<
  A extends readonly unknown[] = readonly unknown[],
  R = unknown,
> {
  readonly spec: RuleOperatorSpec;
  evaluate(args: A, facts: RuleFacts): R;
}

/* --------------------------- Facts & context --------------------------- */

export const RuleEvaluationContext = z.object({
  facts: RuleFacts,
  /** Evaluation time as a FACT (ADR-015). The only "now" a rule may see. */
  now: IsoTimestamp,
  parameters: z.record(z.string(), z.unknown()).default({}),
  operatorRegistryVersion: SemVer,
});
export type RuleEvaluationContext = z.infer<typeof RuleEvaluationContext>;

/* ------------------------------ Definition ----------------------------- */

export const RuleOutcomeBranch = z.object({
  outcome: z.string().min(1),
  when: RuleExpression,
  emit: z.record(z.string(), z.unknown()).optional(),
});
export type RuleOutcomeBranch = z.infer<typeof RuleOutcomeBranch>;

export const RuleParameterDecl = z.object({
  name: z.string().min(1),
  type: z.enum(['boolean', 'number', 'string', 'string[]', 'number[]']),
  tenantOverridable: z.boolean().default(true),
  default: z.unknown().optional(),
});
export type RuleParameterDecl = z.infer<typeof RuleParameterDecl>;

export const RuleDefinitionBody = z.object({
  /** First matching branch wins; `defaultOutcome` required. */
  branches: z.array(RuleOutcomeBranch).min(1),
  defaultOutcome: z.string().min(1),
  parameters: z.array(RuleParameterDecl).default([]),
  requiredFacts: z.array(z.string()).default([]),
});
export type RuleDefinitionBody = z.infer<typeof RuleDefinitionBody>;

export const RuleDefinition = z.object({
  definitionId: DefinitionId,
  kind: z.literal('rule'),
  version: SemVer,
  body: RuleDefinitionBody,
});
export type RuleDefinition = z.infer<typeof RuleDefinition>;

/* ---------------------------- Compiled plan ---------------------------- */

export const CompiledRulePlan = CompiledPlanBase.extend({
  kind: z.literal('rule'),
  branches: z.array(
    z.object({
      outcome: z.string(),
      when: RuleExpression,
      emit: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  defaultOutcome: z.string(),
  parameters: z.array(RuleParameterDecl),
  requiredFacts: z.array(z.string()),
  /** Operators referenced, pinned by version (replay determinism). */
  operatorRefs: z.array(z.object({op: z.string(), version: SemVer})),
});
export type CompiledRulePlan = z.infer<typeof CompiledRulePlan>;

/* ---------------------------- Result & port ---------------------------- */

export const RuleEvaluationResult = z.object({
  matched: z.boolean(), // false ⇒ defaultOutcome used
  outcome: z.string(),
  emit: z.record(z.string(), z.unknown()).optional(),
  trace: z
    .array(
      z.object({
        op: z.string(),
        args: z.array(z.unknown()),
        result: z.unknown(),
      }),
    )
    .default([]),
  evaluatedAt: IsoTimestamp,
});
export type RuleEvaluationResult = z.infer<typeof RuleEvaluationResult>;

/** The single RuleRuntime interpreter surface (pure over provided facts). */
export interface RuleRuntime {
  evaluate(
    plan: CompiledRulePlan,
    ctx: RuleEvaluationContext,
  ): RuleEvaluationResult;
}
