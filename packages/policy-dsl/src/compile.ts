// The policy compiler (ADR-019/016): validate a PolicyDefinition, enforce the site/effect
// constraints, pin referenced operators by version, and produce an immutable content-hashed
// CompiledPolicyPlan (voters + preGates + postGates). Pure given injected identity/time.
import {
  CompiledPolicyPlan,
  PolicyDefinition,
  type PlanId,
  type PolicyRule,
  type RuleExpression,
  type IsoTimestamp,
  type SemVer,
} from '@hermes-one/contracts';
import type {OperatorRegistry} from '@hermes-one/expression-core';
import {contentHashOf} from '@hermes-one/definition-substrate';

export class PolicyCompileError extends Error {}

/** Collect every operator name referenced in an expression tree. */
function collectOps(expr: RuleExpression, into: Set<string>): void {
  switch (expr.type) {
    case 'op':
      into.add(expr.op);
      expr.args.forEach(a => collectOps(a, into));
      break;
    case 'and':
      expr.all.forEach(a => collectOps(a, into));
      break;
    case 'or':
      expr.any.forEach(a => collectOps(a, into));
      break;
    case 'not':
      collectOps(expr.expr, into);
      break;
    // literal / fact / param reference no operators
  }
}

/**
 * Stage 4 type check + stage 7 bounds: assert `spec.pure === true`
 * (POLICY_OPERATOR_NOT_PURE), check arity and the return type where a boolean is required — the root
 * of a `when` and every and/or/not child — (POLICY_TYPE_MISMATCH), and bound nesting by
 * maxExpressionDepth (POLICY_EXPRESSION_TOO_DEEP). Unknown operators are reported by the pinning
 * pass below (single error site).
 */
function checkExpression(
  expr: RuleExpression,
  registry: OperatorRegistry,
  depth: number,
  maxDepth: number,
  booleanContext: boolean,
): void {
  if (depth > maxDepth) {
    throw new PolicyCompileError(
      `POLICY_EXPRESSION_TOO_DEEP: expression nests deeper than maxExpressionDepth ${maxDepth}`,
    );
  }
  switch (expr.type) {
    case 'op': {
      const resolved = registry.resolve(expr.op);
      if (resolved) {
        const spec = resolved.spec;
        if (!spec.pure) {
          throw new PolicyCompileError(
            `POLICY_OPERATOR_NOT_PURE: operator '${expr.op}' declares spec.pure=false; policies may only use pure operators`,
          );
        }
        if (spec.arity !== 'variadic' && expr.args.length !== spec.arity) {
          throw new PolicyCompileError(
            `POLICY_TYPE_MISMATCH: operator '${expr.op}' expects ${spec.arity} argument(s), got ${expr.args.length}`,
          );
        }
        if (
          booleanContext &&
          spec.returns !== 'boolean' &&
          spec.returns !== 'unknown'
        ) {
          throw new PolicyCompileError(
            `POLICY_TYPE_MISMATCH: operator '${expr.op}' returns '${spec.returns}' where a boolean is required`,
          );
        }
      }
      expr.args.forEach(a =>
        checkExpression(a, registry, depth + 1, maxDepth, false),
      );
      break;
    }
    case 'and':
      expr.all.forEach(a =>
        checkExpression(a, registry, depth + 1, maxDepth, true),
      );
      break;
    case 'or':
      expr.any.forEach(a =>
        checkExpression(a, registry, depth + 1, maxDepth, true),
      );
      break;
    case 'not':
      checkExpression(expr.expr, registry, depth + 1, maxDepth, true);
      break;
    // literal / fact / param carry no operators and terminate the walk
  }
}

/** Stage 5 (constrainSites): voter effect ∈ {allow,deny}; repair postGate-only;
 * defer/approval/handoff preGate-only. */
function constrainSites(rule: PolicyRule): void {
  if (
    rule.site === 'voter' &&
    rule.effect !== 'allow' &&
    rule.effect !== 'deny'
  ) {
    throw new PolicyCompileError(
      `voter rule '${rule.id}' effect must be allow/deny, got '${rule.effect}'`,
    );
  }
  if (rule.effect === 'repair' && rule.site !== 'postGate') {
    throw new PolicyCompileError(
      `rule '${rule.id}': effect 'repair' is postGate-only`,
    );
  }
  if (
    (rule.effect === 'defer' ||
      rule.effect === 'approval' ||
      rule.effect === 'handoff') &&
    rule.site !== 'preGate'
  ) {
    throw new PolicyCompileError(
      `rule '${rule.id}': effect '${rule.effect}' is preGate-only`,
    );
  }
}

export interface CompileOptions {
  registry: OperatorRegistry;
  compilerVersion: SemVer;
  planId: PlanId;
  compiledAt: IsoTimestamp;
  /** Compile-time nesting bound (PolicyCompilerConfig.maxExpressionDepth, default 32). */
  maxExpressionDepth?: number;
}

export function compilePolicy(
  definition: PolicyDefinition,
  opts: CompileOptions,
): CompiledPolicyPlan {
  const def = PolicyDefinition.parse(definition);

  for (const rule of def.body.rules) constrainSites(rule);

  // Type-check + bound every rule predicate (purity, arity, boolean return, depth).
  const maxDepth = opts.maxExpressionDepth ?? 32;
  for (const rule of def.body.rules) {
    checkExpression(rule.when, opts.registry, 1, maxDepth, true);
  }

  // Pin every referenced operator by its registry version (replay determinism).
  const opNames = new Set<string>();
  for (const rule of def.body.rules) collectOps(rule.when, opNames);
  const operatorRefs = [...opNames].sort().map(op => {
    const version = opts.registry.versionOf(op);
    if (!version)
      throw new PolicyCompileError(
        `unknown operator '${op}' (not in registry)`,
      );
    return {op, version};
  });

  const voters = def.body.rules
    .filter(r => r.site === 'voter')
    .map(r => ({
      policyRuleId: r.id,
      appliesTo: r.appliesTo,
      when: r.when,
      verdict: r.effect as 'allow' | 'deny',
      reason: r.reason,
    }));
  const gate = (r: PolicyRule) => ({
    policyRuleId: r.id,
    when: r.when,
    outcome: r.effect,
    reason: r.reason,
    detail: r.detail,
  });
  const preGates = def.body.rules.filter(r => r.site === 'preGate').map(gate);
  const postGates = def.body.rules.filter(r => r.site === 'postGate').map(gate);

  const core = {
    kind: 'policy' as const,
    definitionId: def.definitionId,
    version: def.version,
    compilerVersion: opts.compilerVersion,
    voters,
    preGates,
    postGates,
    defaultVoterVerdict: def.body.defaultVoterVerdict,
    parameters: def.body.parameters,
    operatorRefs,
  };

  return CompiledPolicyPlan.parse({
    planId: opts.planId,
    contentHash: contentHashOf(core),
    compiledAt: opts.compiledAt,
    ...core,
  });
}
