// Composition helpers that combine the eval runner + gates into the pass/fail shape DeploymentService's
// `regressionCheck` hook expects. `runBehavioralRegression` runs the golden suite through the runner and
// applies the RegressionGate; `combineGateResults` ANDs several gate outcomes (e.g. behavioral + scalability)
// so a publish is blocked if ANY gate fails.
import type {
  DeploymentRef,
  EvaluationRunner,
  GoldenConversationCase,
  RegressionGate,
} from '@hermes-one/contracts';

export interface GateResult {
  pass: boolean;
  reason?: string;
  failedCaseIds?: string[];
}

/** Run the golden suite against the candidate deployment and apply the behavioral RegressionGate. */
export async function runBehavioralRegression(
  runner: EvaluationRunner,
  gate: RegressionGate,
  cases: GoldenConversationCase[],
  deploymentRef: DeploymentRef,
): Promise<GateResult> {
  const results = await runner.runSuite(cases, deploymentRef);
  const g = gate.evaluate(results, cases);
  return g.pass
    ? {pass: true}
    : {pass: false, reason: g.reason, failedCaseIds: g.failedCaseIds};
}

/** AND several gate results — the publish passes only if every gate passes. */
export function combineGateResults(results: GateResult[]): GateResult {
  const failed = results.filter(r => !r.pass);
  if (failed.length === 0) return {pass: true};
  return {
    pass: false,
    reason: failed.map(f => f.reason ?? 'gate failed').join('; '),
    failedCaseIds: failed.flatMap(f => f.failedCaseIds ?? []),
  };
}
