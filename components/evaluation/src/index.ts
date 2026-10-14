// @platform-internal/evaluation — component (agent plane).
// The golden-conversation evaluation framework: plays
// cases through the ONE turn loop against mock providers (dryRun), scores assertions, gates deployment
// publish on required-case regressions. The workflow-level Temporal simulation is deferred (see
// docs/DEFERRED-AND-FLAGGED.md OB6).
export {
  TurnSimulationService,
  type TurnSimulationDeps,
  type TurnSimulationOutput,
} from './simulation.js';
export {
  DefaultEvaluationRunner,
  DefaultRegressionGate,
  scoreAssertion,
  type SimulateTurnFn,
} from './runner.js';
export {
  runBehavioralRegression,
  combineGateResults,
  type GateResult,
} from './gate-check.js';
export {
  composeCandidateRegressionCheck,
  type CandidateCheckDeps,
  type CandidateMemberRefs,
} from './candidate-check.js';

export const descriptor = {
  name: '@platform-internal/evaluation',
  role: 'component',
  plane: 'agent',
  published: false,
  governedBy: ['ADR-021'],
} as const;
