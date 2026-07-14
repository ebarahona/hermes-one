// The pure PolicyRuntime (ADR-019): screens a compiled policy plan at the pre-gate (turn-level) and
// post-gate (composed reply) sites. First gate whose `when` holds wins; if none fires the decision is
// allow. Voter projection is identity (agentback enforces voters at dispatch). Same algorithm the live
// agent-plane gate chain uses — this is the shared, deterministic evaluator (time enters as facts.now).
import {evaluatePredicate, type OperatorRegistry} from '@platform/expression-core';
import type {
  CompiledPolicyPlan,
  CompiledVoter,
  PolicyDecision,
  PolicyEvaluationContext,
  PolicyRuntime,
} from '@platform/contracts';

export class ExpressionPolicyRuntime implements PolicyRuntime {
  constructor(private readonly operators: OperatorRegistry) {}

  evaluatePreGates(plan: CompiledPolicyPlan, ctx: PolicyEvaluationContext): PolicyDecision {
    return this.evaluateGates(plan.preGates, ctx);
  }

  evaluatePostGates(plan: CompiledPolicyPlan, ctx: PolicyEvaluationContext): PolicyDecision {
    return this.evaluateGates(plan.postGates, ctx);
  }

  toVoters(plan: CompiledPolicyPlan): CompiledVoter[] {
    return plan.voters;
  }

  private evaluateGates(
    gates: CompiledPolicyPlan['preGates'],
    ctx: PolicyEvaluationContext,
  ): PolicyDecision {
    const facts = {...ctx.facts, now: ctx.now};
    for (const g of gates) {
      if (evaluatePredicate(g.when, {facts, parameters: ctx.parameters, registry: this.operators})) {
        return {
          outcome: g.outcome,
          policyRuleId: g.policyRuleId,
          reason: g.reason,
          detail: g.detail,
          decidedAt: ctx.now,
        };
      }
    }
    return {outcome: 'allow', policyRuleId: '<none>', reason: 'no gate fired', decidedAt: ctx.now};
  }
}
