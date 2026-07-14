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

export interface CompileOptions {
  registry: OperatorRegistry;
  compilerVersion: SemVer;
  /** Injected identity + time keep the compiler pure (no id-gen / clock inside). */
  planId: PlanId;
  compiledAt: IsoTimestamp;
}

export function compileRule(
  definition: RuleDefinition,
  opts: CompileOptions,
): CompiledRulePlan {
  const def = RuleDefinition.parse(definition);

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
