// Single-step loop primitives (ADR-021). The model PROPOSES one step; the platform gates, executes,
// and re-prompts — this is NOT an autonomous agent loop. The bounded, gated turn that drives these is
// runTurn (turn.ts); these are the shared types the decider and the turn agree on.
import type {ToolCall, ToolResult} from '@hermes-one/contracts';
import type {ModelUsage} from '@hermes-one/model-client';

/** One single-step model proposal: invoke exactly one tool, or finish. Carries the step's token usage. */
export type Decision =
  | {kind: 'tool'; call: ToolCall; usage: ModelUsage}
  | {kind: 'done'; reply?: string; usage: ModelUsage};

/** The platform's single-step decider — proposes exactly one action per step. */
export interface Decider {
  propose(step: number, history: ToolResult[]): Decision | Promise<Decision>;
}
