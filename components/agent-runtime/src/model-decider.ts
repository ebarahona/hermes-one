// A Decider backed by a real single-step model (ADR-021). Each step it gives the model the objective +
// eligible tools + results so far and asks for ONE action; a tool call maps to a platform ToolCall,
// otherwise the turn is done. Provider-legal tool names (no dots) map back to capability names. The
// executor derives the real idempotency key from the capability contract; the decider supplies a
// placeholder the turn/executor may override.
import type {CapabilityName, ToolCall} from '@platform/contracts';
import type {ModelToolSpec, SingleStepModel} from '@platform-internal/model-client';
import type {Decider} from './single-step-loop.js';

export interface DeciderTool {
  /** Provider-legal tool name exposed to the model (no dots). */
  toolName: string;
  /** The platform capability this tool maps to. */
  capability: CapabilityName;
  description: string;
  /** JSON Schema for the tool input (object root). */
  parameters: Record<string, unknown>;
}

export function createModelDecider(opts: {
  model: SingleStepModel;
  objective: string;
  tools: DeciderTool[];
  now?: () => number;
}): Decider {
  const now = opts.now ?? (() => Date.now());
  const specs: ModelToolSpec[] = opts.tools.map(t => ({
    name: t.toolName,
    description: t.description,
    parameters: t.parameters,
  }));

  return {
    async propose(step, history) {
      const system =
        'You are a bounded task agent. If a tool helps accomplish the objective, call exactly one ' +
        `tool. Otherwise give a short final answer. Objective: ${opts.objective}`;
      const user =
        step === 0
          ? opts.objective
          : `Results so far: ${history
              .map(h => `${h.capability}=${JSON.stringify(h.output)}`)
              .join('; ')}. Continue or finish.`;

      const result = await opts.model.complete({
        messages: [
          {role: 'system', content: system},
          {role: 'user', content: user},
        ],
        tools: specs,
      });

      const proposed = result.toolCalls[0];
      const tool = proposed && opts.tools.find(t => t.toolName === proposed.name);
      if (!proposed || !tool) {
        return {kind: 'done', reply: result.text || undefined, usage: result.usage};
      }

      const call: ToolCall = {
        toolCallId: `tc_${now()}_${step}` as ToolCall['toolCallId'],
        capability: tool.capability,
        input: proposed.arguments,
        idempotencyKey: `idem_${tool.capability}_${JSON.stringify(proposed.arguments)}`,
        proposedAt: new Date(now()).toISOString() as ToolCall['proposedAt'],
      };
      return {kind: 'tool', call, usage: result.usage};
    },
  };
}
