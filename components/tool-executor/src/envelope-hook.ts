// Dispatch-hook half of the ToolResult synthesis (ADR-018). agentback's
// invokeTool is private; the platform wraps the public `MCPServer.callTool`
// seam and enriches its unwrapped result. A dispatch hook wraps the WHOLE
// dispatch, so it is where `evidence` and `metrics` are collected — attached to
// a per-call collector the executor binds into the request context.
import type {Context} from '@agentback/context';
import type {McpDispatchHook} from '@agentback/mcp';
import type {EvidenceRecord, ToolCallId, ToolMetrics, TurnId} from '@platform/contracts';

/** Binding key for the per-call collector the executor seeds and the hook fills. */
export const COLLECTOR_KEY = 'platform.turn.collector';

/** Mutable per-call sink the dispatch hook writes into. Carries the ids the hook stamps evidence with. */
export interface TurnCollector {
  evidence: EvidenceRecord[];
  metrics: Partial<ToolMetrics>;
  turnId: TurnId;
  toolCallId: ToolCallId;
}

/** Read the collector off the request context chain (bound by the executor). */
export async function collectorFor(
  ctx: Context,
): Promise<TurnCollector | undefined> {
  return ctx.get<TurnCollector>(COLLECTOR_KEY, {optional: true});
}

/**
 * A dispatch hook that times the dispatch and records one grounded evidence
 * record from a successful tool output. Bind before `app.start()` and tag it
 * `MCP_DISPATCH_HOOK_TAG` (the list is cached on first dispatch).
 *
 * `now`/`newId` are injected so the hook stays testable and deterministic; the
 * agent turn runs inside a Temporal activity, where wall-clock is permitted.
 */
export function createEnvelopeHook(deps?: {
  now?: () => number;
  isoNow?: () => string;
  newId?: () => string;
}): McpDispatchHook {
  const now = deps?.now ?? (() => Date.now());
  const isoNow = deps?.isoNow ?? (() => new Date().toISOString());
  let seq = 0;
  const newId = deps?.newId ?? (() => `evd_${++seq}`);

  return async (info, next) => {
    const collector = await collectorFor(info.ctx);
    const started = now();
    try {
      const result = await next();
      if (collector) {
        collector.metrics.latencyMs = now() - started;
        collector.evidence.push({
          id: newId() as EvidenceRecord['id'],
          turnId: collector.turnId,
          toolCallId: collector.toolCallId,
          kind: 'tool-output',
          capability: info.tool.meta.name as EvidenceRecord['capability'],
          statement: `Tool ${info.tool.meta.name} returned a result.`,
          data:
            result && typeof result === 'object'
              ? (result as Record<string, unknown>)
              : {value: result},
          source: 'authoritative',
          trusted: true,
          observedAt: isoNow() as EvidenceRecord['observedAt'],
        } as EvidenceRecord);
      }
      return result;
    } catch (err) {
      if (collector) collector.metrics.latencyMs = now() - started;
      throw err;
    }
  };
}
