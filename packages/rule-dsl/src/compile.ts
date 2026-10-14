// The rule compiler (ADR-015/016): validate a RuleDefinition, pin the operators
// it references by version, and produce an immutable content-hashed
// CompiledRulePlan. Pure given injected identity/time (planId, compiledAt) — no
// I/O, no clock of its own.
import {
  CompiledRulePlan,
  RuleDefinition,
  type PlanId,
  type RuleExpression,
  type IsoTimestamp,
  type SemVer,
} from '@platform/contracts';
import type {OperatorRegistry} from '@platform/expression-core';
import {contentHashOf} from '@platform/definition-substrate';

export class RuleCompileError extends Error {}

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
 * Compile-time operator checks: assert `spec.pure === true`, check arity against
 * the argument count, check the return type where a boolean is required (root of a `when` and every
 * and/or/not child), and bound nesting by maxExpressionDepth. Unknown operators are reported by the
 * pinning pass below (single error site).
 */
function checkExpression(
  expr: RuleExpression,
  registry: OperatorRegistry,
  depth: number,
  maxDepth: number,
  booleanContext: boolean,
): void {
  if (depth > maxDepth) {
    throw new RuleCompileError(
      `RULE_EXPRESSION_TOO_DEEP: expression nests deeper than maxExpressionDepth ${maxDepth}`,
    );
  }
  switch (expr.type) {
    case 'op': {
      const resolved = registry.resolve(expr.op);
      if (resolved) {
        const spec = resolved.spec;
        if (!spec.pure) {
          throw new RuleCompileError(
            `RULE_OPERATOR_NOT_PURE: operator '${expr.op}' declares spec.pure=false; rules may only use pure operators`,
          );
        }
        if (spec.arity !== 'variadic' && expr.args.length !== spec.arity) {
          throw new RuleCompileError(
            `RULE_OPERATOR_ARITY: operator '${expr.op}' expects ${spec.arity} argument(s), got ${expr.args.length}`,
          );
        }
        if (booleanContext && spec.returns !== 'boolean' && spec.returns !== 'unknown') {
          throw new RuleCompileError(
            `RULE_OPERATOR_RETURN_TYPE: operator '${expr.op}' returns '${spec.returns}' where a boolean is required`,
          );
        }
      }
      expr.args.forEach(a => checkExpression(a, registry, depth + 1, maxDepth, false));
      break;
    }
    case 'and':
      expr.all.forEach(a => checkExpression(a, registry, depth + 1, maxDepth, true));
      break;
    case 'or':
      expr.any.forEach(a => checkExpression(a, registry, depth + 1, maxDepth, true));
      break;
    case 'not':
      checkExpression(expr.expr, registry, depth + 1, maxDepth, true);
      break;
    // literal / fact / param carry no operators and terminate the walk
  }
}

export interface CompileOptions {
  registry: OperatorRegistry;
  compilerVersion: SemVer;
  /** Injected identity + time keep the compiler pure (no id-gen / clock inside). */
  planId: PlanId;
  compiledAt: IsoTimestamp;
  /** Compile-time nesting bound (RuleCompilerConfig.maxExpressionDepth, default 32). */
  maxExpressionDepth?: number;
}

export function compileRule(
  definition: RuleDefinition,
  opts: CompileOptions,
): CompiledRulePlan {
  const def = RuleDefinition.parse(definition);

  // Type-check + bound every branch predicate (purity, arity, boolean return, depth).
  const maxDepth = opts.maxExpressionDepth ?? 32;
  for (const b of def.body.branches) {
    checkExpression(b.when, opts.registry, 1, maxDepth, true);
  }

  // Pin every referenced operator by its registry version (replay determinism).
  const opNames = new Set<string>();
  for (const b of def.body.branches) collectOps(b.when, opNames);

  const operatorRefs = [...opNames].sort().map(op => {
    const version = opts.registry.versionOf(op);
    if (!version) {
      throw new RuleCompileError(`unknown operator '${op}' (not in registry)`);
    }
    return {op, version};
  });

  // Canonical core (everything that defines the plan's identity) → content hash.
  const core = {
    kind: 'rule' as const,
    definitionId: def.definitionId,
    version: def.version,
    compilerVersion: opts.compilerVersion,
    branches: def.body.branches,
    defaultOutcome: def.body.defaultOutcome,
    parameters: def.body.parameters,
    requiredFacts: def.body.requiredFacts,
    operatorRefs,
  };

  return CompiledRulePlan.parse({
    planId: opts.planId,
    contentHash: contentHashOf(core),
    compiledAt: opts.compiledAt,
    ...core,
  });
}
