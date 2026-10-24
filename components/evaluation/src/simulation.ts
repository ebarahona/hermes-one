// TurnSimulationService (agent plane) — the eval/replay execution substrate. Runs a golden case's turn
// through the SAME single-step loop real turns use (`runTurn`, the ONE turn implementation — no divergent
// path, per ADR-021) with injected deps (mock providers/decider for CI, or real ones). It is dryRun: the
// `onPersist` sink captures the TurnLedger IN MEMORY and NEVER writes to the audit/usage/ledger tables, so
// evaluation traffic can't contaminate real data.
//
// FLAGGED: the design's SimulationService.simulateWorkflow runs the WHOLE workflow through a Temporal
// mock-provider worker on a separate task queue; this is a turn-level, in-process cut that reuses the real
// turn loop. The workflow-level Temporal simulation (+ the workflowId-loading signature) is deferred
// (DEFERRED-AND-FLAGGED OB6).
import {
  runTurn,
  type TurnDeps,
  type TurnLedger,
} from '@hermes-one/agent-runtime';
import type {TurnRequest, TurnResult} from '@hermes-one/contracts';

/** The turn deps a simulation runs against — the executor + decider are mock (CI) or real (shadow eval). */
export interface TurnSimulationDeps {
  executor: TurnDeps['executor'];
  decider: TurnDeps['decider'];
  policy?: TurnDeps['policy'];
  approve?: TurnDeps['approve'];
}

export interface TurnSimulationOutput {
  result: TurnResult;
  /** The full ledger captured in memory (never persisted) — the assertion-scoring surface. */
  ledger: TurnLedger;
}

export class TurnSimulationService {
  /** Fixed clock by default (deterministic sim); inject a real clock for wall-time. */
  constructor(private readonly nowMs: () => number = () => 0) {}

  async simulateTurn(
    request: TurnRequest,
    deps: TurnSimulationDeps,
  ): Promise<TurnSimulationOutput> {
    let captured: TurnLedger | undefined;
    const result = await runTurn(request, {
      executor: deps.executor,
      decider: deps.decider,
      policy: deps.policy,
      approve: deps.approve,
      onPersist: async l => {
        captured = l; // dryRun: capture only — NEVER persist (eval traffic is quarantined)
      },
      clock: {nowMs: this.nowMs},
    });
    // onPersist runs at every terminal path of runTurn, so the ledger is always captured.
    return {result, ledger: captured as TurnLedger};
  }
}
