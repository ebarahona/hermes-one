// Worker versioning + interpreter-change discipline (ADR-029 pins the API generation — see below). The ONE
// interpreter (`executeCompiledWorkflow`, ADR-014) is the single deterministic surface for the whole
// fleet: every edit to it is classified, and NO candidate build becomes the default until every
// captured history replays against it without a nondeterminism error. Two orthogonal pinning axes,
// never conflated: WHICH INTERPRETER CODE runs (buildId — this module) vs WHICH COMPILED PLAN it
// walks (planRef contentHash). Publishing a plan never needs a
// new buildId; shipping a buildId never republishes plans.
//
// NOTE (flagged, ADR-029): the `BuildIdRegistry` design is
// written against Temporal's LEGACY compatible-sets API (`useVersioning`/`buildId`), which
// @temporalio 1.20.2 marks @deprecated. ADR-029 pins the successor (Worker Deployments:
// `workerDeploymentOptions` with `PINNED` behavior — exactly the open-executions-stay-put
// intent). The registry's deploy-time tooling lands with the deployment pipeline; what ships NOW is
// the classification table, the buildId derivation, the worker options, and the REPLAY GATE (hard
// CI blocker, generation-independent).
import type {IsoTimestamp} from '@hermes-one/contracts';

/* ------------------------- Change classification (verbatim) ------------------------- */

export type InterpreterChangeClass = 'compatible' | 'risky';

export type InterpreterChangeKind =
  // compatible — replaying an old history through the new code never diverges
  | 'new-node-kind'
  | 'new-optional-plan-field'
  | 'log-or-metric-only'
  | 'error-message-text'
  // risky — can change the sequence/shape of commands an old history expects
  | 'reorder-activity-calls'
  | 'change-activity-arguments'
  | 'add-remove-timer-or-signal-wait'
  | 'change-retry-or-timeout-options'
  | 'conditional-flow-around-existing-commands';

export const INTERPRETER_CHANGE_CLASS: Record<
  InterpreterChangeKind,
  InterpreterChangeClass
> = {
  'new-node-kind': 'compatible',
  'new-optional-plan-field': 'compatible',
  'log-or-metric-only': 'compatible',
  'error-message-text': 'compatible',
  'reorder-activity-calls': 'risky',
  'change-activity-arguments': 'risky',
  'add-remove-timer-or-signal-wait': 'risky',
  'change-retry-or-timeout-options': 'risky',
  'conditional-flow-around-existing-commands': 'risky',
};

/* ------------------------- Build identity (ADR-029 generation) ------------------------- */

/** `workflow-worker@<yyyy.mm.dd>+sha.<gitsha>` — the composite build id. */
export type WorkerBuildId = string;

export function deriveBuildId(gitSha: string, date: Date): WorkerBuildId {
  const d = date.toISOString().slice(0, 10).replace(/-/g, '.');
  return `workflow-worker@${d}+sha.${gitSha.slice(0, 7)}`;
}

/**
 * The workflow-worker's versioning options in the PINNED generation (ADR-029). ONLY the
 * workflow-worker is versioned — activity/agent workers host no workflow code.
 * `enabled: false` (dev default) runs unversioned exactly as before; flipping it on requires the
 * server's Worker Deployments support verified live first (ADR-029 (3)).
 */
export interface WorkflowWorkerVersioning {
  enabled: boolean;
  buildId: WorkerBuildId;
  deploymentName: string; // canonical form is `${deploymentName}.${buildId}`
}

/* ------------------------- Replay gate (verbatim; generation-independent) ------------------------- */

export interface ReplayHistoryFixture {
  fixtureId: string;
  // Spec says 'executeCompiledWorkflow'; the repo's REGISTERED types are the host workflows that
  // call it in-process (flagged — same one-interpreter surface, different registration names).
  workflowType: 'runMissedCall' | 'runTriage' | 'executeCompiledWorkflow';
  capturedFromBuildId: WorkerBuildId;
  source: 'production-export' | 'golden-test';
  /** Opaque Temporal history payload (proto/JSON export) — replayed via the SDK's replay harness. */
  history: unknown;
  tags: string[];
}

export interface ReplayNondeterminismError {
  fixtureId: string;
  message: string;
}

export interface ReplayGateResult {
  candidateBuildId: WorkerBuildId;
  fixturesRun: number;
  fixturesPassed: number;
  nondeterminismErrors: ReplayNondeterminismError[];
  /** true iff nondeterminismErrors.length === 0 AND fixturesRun === fixturesPassed */
  passed: boolean;
}

export interface ReplayGateConfig {
  minFixtures: number; // default 50 is "a reasonable default, not ratified" — config
  /** const true — no waiver path (there is no override path). */
  failBuildOnAnyNondeterminism: true;
}

export interface ReplayTestGate {
  loadFixtures(): Promise<ReplayHistoryFixture[]>;
  replay(
    candidateBuildId: WorkerBuildId,
    fixtures: ReplayHistoryFixture[],
  ): Promise<ReplayGateResult>;
}

/** Retirement discipline for a drained build (deploy-time tooling; transcribed for the pipeline). */
export interface DrainPolicy {
  buildId: WorkerBuildId;
  /** Never retire before this elapses, even at openExecutionCount 0. */
  minDrainWindowMs: number;
  checkIntervalMs: number;
  /** Ops alert, not auto-termination. */
  alertIfOpenAfterMs: number;
}

export interface BuildIdRecord {
  buildId: WorkerBuildId;
  state:
    'candidate' | 'gated' | 'current' | 'retained' | 'retiring' | 'retired';
  compatibleWith: WorkerBuildId | null;
  registeredAt: IsoTimestamp;
  promotedToDefaultAt: IsoTimestamp | null;
  openExecutionCount: number;
}
