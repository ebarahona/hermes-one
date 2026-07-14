// @platform-internal/agent-runtime — component (agent plane).
// The platform-owned, policy-gated single-step agent turn (ADR-021/019/009/018).

export {
  runTurn,
  type TurnDeps,
  type TurnPolicy,
  type ApproveFn,
  type TurnLedger,
  type TurnLedgerToolExecution,
  type TurnLedgerPolicyDecision,
  type TurnLedgerHandoff,
} from './turn.js';
export {createModelDecider, type DeciderTool} from './model-decider.js';
export {composeEvidenceOnly, type Composer} from './compose.js';
export type {Decider, Decision} from './single-step-loop.js';

export const descriptor = {
  name: '@platform-internal/agent-runtime',
  role: 'component',
  plane: 'agent',
  published: false,
  sourceDocs: ['04-agent-runtime/050', '057', 'contracts/agent-runtime-contracts'],
  governedBy: ['ADR-009', 'ADR-018', 'ADR-019', 'ADR-021'],
} as const;
