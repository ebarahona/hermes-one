// The single RuleRuntime interpreter (ADR-015): a PURE first-match walk over a
// compiled plan's branches. No I/O, no side effects, no clock — evaluation time
// is `ctx.now`, exposed to expressions as the `now` fact. Two evaluations with
// identical (plan, ctx) produce identical results (Temporal replay safety).
import type {
  CompiledRulePlan,
  RuleEvaluationContext,
  RuleEvaluationResult,
  RuleRuntime,
} from '@platform/contracts';
import {
  evaluatePredicate,
  type OperatorRegistry,
  type TraceEntry,
} from '@platform/expression-core';

export class RuleEvaluationError extends Error {}

export class RuleRuntimeImpl implements RuleRuntime {
  constructor(private readonly registry: OperatorRegistry) {}

  evaluate(
    plan: CompiledRulePlan,
    ctx: RuleEvaluationContext,
  ): RuleEvaluationResult {
    // Refuse a plan whose pinned operators disagree with the live registry
    // (requirePinnedOperatorVersions — replay determinism).
    for (const ref of plan.operatorRefs) {
      const live = this.registry.versionOf(ref.op);
      if (live !== ref.version) {
        throw new RuleEvaluationError(
          `operator '${ref.op}' pinned at ${ref.version} but registry has ${live ?? 'none'}`,
        );
      }
    }

    // Time enters as a fact (ADR-015): expose `ctx.now` as the `now` fact.
    const facts = {...ctx.facts, now: ctx.now};
    const trace: TraceEntry[] = [];
    const opts = {
      facts,
      parameters: ctx.parameters,
      registry: this.registry,
      trace,
    };

    for (const branch of plan.branches) {
      if (evaluatePredicate(branch.when, opts)) {
        return {
          matched: true,
          outcome: branch.outcome,
          emit: branch.emit,
          trace,
          evaluatedAt: ctx.now,
        };
      }
    }

    return {
      matched: false,
      outcome: plan.defaultOutcome,
      trace,
      evaluatedAt: ctx.now,
    };
  }
}

/** Convenience factory. */
export function createRuleRuntime(registry: OperatorRegistry): RuleRuntime {
  return new RuleRuntimeImpl(registry);
}
