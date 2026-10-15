// Dispatch-hook half of the ToolResult synthesis (ADR-018). agentback's
// invokeTool is private; the platform wraps the public `MCPServer.callTool`
// seam and enriches its unwrapped result. A dispatch hook wraps the WHOLE
// dispatch, so it is where `evidence` and `metrics` are collected — attached to
// a per-call collector the executor binds into the request context.
import {createHash} from 'node:crypto';
import type {Context} from '@agentback/context';
import type {McpDispatchHook} from '@agentback/mcp';
import type {
  EvidenceRecord,
  ToolCallId,
  ToolMetrics,
  TurnId,
} from '@platform/contracts';

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
  newId?: (scope: {
    turnId: TurnId;
    toolCallId: ToolCallId;
    ordinal: number;
  }) => string;
}): McpDispatchHook {
  const now = deps?.now ?? (() => Date.now());
  const isoNow = deps?.isoNow ?? (() => new Date().toISOString());
  // Deterministic, turn-scoped evidence id (mirrors the pld_/hof_ recipe in agent-runtime turn.ts):
  // derived from (turnId, toolCallId, ordinal-within-call) so a Temporal retry of the same turn
  // re-derives the IDENTICAL id (replay collapses via evidence_records' ON CONFLICT DO NOTHING) and
  // two different turns can never mint the same id. The old per-process counter did neither — the
  // hook is created once per worker, so restarts/replicas restarted the sequence and collided on the
  // bare global PK.
  const newId =
    deps?.newId ??
    (({
      turnId,
      toolCallId,
      ordinal,
    }: {
      turnId: TurnId;
      toolCallId: ToolCallId;
      ordinal: number;
    }) =>
      `evd_${createHash('sha256').update(`${turnId}:${toolCallId}:${ordinal}`).digest('hex').slice(0, 24)}`);

  return async (info, next) => {
    const collector = await collectorFor(info.ctx);
    const started = now();
    try {
      const result = await next();
      if (collector) {
        collector.metrics.latencyMs = now() - started;
        collector.evidence.push({
          id: newId({
            turnId: collector.turnId,
            toolCallId: collector.toolCallId,
            ordinal: collector.evidence.length,
          }) as EvidenceRecord['id'],
          turnId: collector.turnId,
          toolCallId: collector.toolCallId,
          kind: 'tool-output',
          capability: info.tool.meta.name as EvidenceRecord['capability'],
          statement: `Tool ${info.tool.meta.name} returned a result.`,
          data:
            result && typeof result === 'object'
              ? (result as Record<string, unknown>)
              : {value: result},
          // Follows the canonical tool-output example: a result from a capability the PLATFORM invoked is authoritative/trusted.
          // `trusted:false` is the indirect-injection defense for RETRIEVED content (the other
          // example is source:'retrieved'), not for structured capability results. ADR-009
          // evidence-only composition grounds ONLY on trusted evidence (compose.ts) — stamping this
          // untrusted silently strips the agent of the very facts it just fetched.
          // NOTE: CapabilityInvoker stamps provider/false for the same tool-output — the two paths
          // disagree. Flagged (DEFERRED-AND-FLAGGED A6); not silently reconciled either way.
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
