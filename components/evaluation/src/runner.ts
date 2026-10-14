// EvaluationRunner + RegressionGate. The runner plays a
// golden case's scripted turns through the injected simulate seam (TurnSimulationService bound to the
// case's deployment deps), scores each assertion against the resulting TurnResult/ledger, and returns an
// EvaluationResult (dryRun:true). The RegressionGate blocks a deployment publish on any 'required'-severity
// case failure. Pure scoring + orchestration — the turn execution is the ONE loop (no reimplementation).
//
// FLAGGED: the runner takes an injected `simulate(inbound, deploymentRef)` rather than loading the pinned
// deployment's engine/capabilities/policy itself (the agent-activity does that in production) — wiring the
// runner to load-from-deployment is a follow-on (DEFERRED-AND-FLAGGED). `atStepOrLater` is matched by the
// tool call's index in TurnResult.toolCalls.
import {
  EvaluationResult,
  type DeploymentRef,
  type EvaluationAssertion,
  type EvaluationResult as EvaluationResultType,
  type EvaluationRunner,
  type GoldenConversationCase,
  type IsoTimestamp,
  type RegressionGate,
} from '@platform/contracts';
import type {TurnSimulationOutput} from './simulation.js';

/** Runs one scripted inbound turn against a deployment and returns the captured turn output. */
export type SimulateTurnFn = (
  inbound: {text: string; attachments: {kind: string; ref: string}[]},
  deploymentRef: DeploymentRef,
) => Promise<TurnSimulationOutput>;

type AssertionResult = {assertion: EvaluationAssertion; passed: boolean; detail?: string};

/** Score one assertion against every turn's output (an assertion passes if it holds for ANY turn). */
export function scoreAssertion(assertion: EvaluationAssertion, outputs: TurnSimulationOutput[]): AssertionResult {
  const fail = (detail: string): AssertionResult => ({assertion, passed: false, detail});
  const pass: AssertionResult = {assertion, passed: true};

  switch (assertion.kind) {
    case 'tool-called': {
      const hit = outputs.some(o =>
        o.result.toolCalls.some((c, i) => c.capability === assertion.capability && i >= assertion.atStepOrLater),
      );
      return hit ? pass : fail(`capability '${assertion.capability}' was not called at step ≥ ${assertion.atStepOrLater}`);
    }
    case 'tool-not-called': {
      const called = outputs.some(o => o.result.toolCalls.some(c => c.capability === assertion.capability));
      return called ? fail(`capability '${assertion.capability}' was called but should not have been`) : pass;
    }
    case 'evidence-contains': {
      const re = new RegExp(assertion.pattern);
      const hit = outputs.some(o => o.ledger.evidence.some(e => re.test(e.statement)));
      return hit ? pass : fail(`no evidence statement matched /${assertion.pattern}/`);
    }
    case 'reply-matches': {
      const re = new RegExp(assertion.pattern);
      const hit = outputs.some(o => typeof o.result.reply === 'string' && re.test(o.result.reply));
      return hit ? pass : fail(`no reply matched /${assertion.pattern}/`);
    }
    case 'policy-outcome': {
      const hit = outputs.some(o =>
        o.ledger.policyDecisions.some(d => d.site === assertion.site && d.decision.outcome === assertion.outcome),
      );
      return hit ? pass : fail(`no ${assertion.site} decision had outcome '${assertion.outcome}'`);
    }
    case 'turn-outcome': {
      const hit = outputs.some(o => o.result.outcome === assertion.outcome);
      return hit ? pass : fail(`no turn had outcome '${assertion.outcome}'`);
    }
  }
}

export class DefaultEvaluationRunner implements EvaluationRunner {
  constructor(
    private readonly simulate: SimulateTurnFn,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async runCase(goldenCase: GoldenConversationCase, deploymentRef: DeploymentRef): Promise<EvaluationResultType> {
    const outputs: TurnSimulationOutput[] = [];
    for (const turn of goldenCase.turns) outputs.push(await this.simulate(turn, deploymentRef));
    const assertionResults = goldenCase.assertions.map(a => scoreAssertion(a, outputs));
    return EvaluationResult.parse({
      caseId: goldenCase.caseId,
      deploymentRef,
      passed: assertionResults.every(r => r.passed),
      assertionResults,
      ranAt: this.clock().toISOString() as IsoTimestamp,
      dryRun: true,
    });
  }

  async runSuite(goldenCases: GoldenConversationCase[], deploymentRef: DeploymentRef): Promise<EvaluationResultType[]> {
    const out: EvaluationResultType[] = [];
    for (const c of goldenCases) out.push(await this.runCase(c, deploymentRef));
    return out;
  }
}

export class DefaultRegressionGate implements RegressionGate {
  evaluate(
    results: EvaluationResultType[],
    cases: GoldenConversationCase[],
  ): {pass: true} | {pass: false; reason: string; failedCaseIds: string[]} {
    const severity = new Map(cases.map(c => [c.caseId, c.severity]));
    const failedCaseIds = results
      .filter(r => !r.passed && severity.get(r.caseId) === 'required')
      .map(r => r.caseId);
    if (failedCaseIds.length === 0) return {pass: true};
    return {
      pass: false,
      reason: `${failedCaseIds.length} required golden case(s) failed`,
      failedCaseIds,
    };
  }
}
