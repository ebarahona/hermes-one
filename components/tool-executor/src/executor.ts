// The platform ToolExecutor (ADR-018): implements the canonical ToolExecutor port
// (execute(call, ctx: TurnContext) → ToolResult). It wraps agentback's public dispatch seam
// `MCPServer.callTool` (invokeTool is private) and synthesizes the rich ToolResult envelope AROUND the
// unwrapped, output-validated result. `sideEffect`/`changedDomains`/`stateChanged` come from CAPABILITY
// METADATA (derived from the CapabilityContract, never a hardcoded map); `evidence`/`metrics` come from
// the dispatch hook. It never re-implements dispatch.
import {Context} from '@agentback/context';
import type {MCPServer} from '@agentback/mcp';
import {
  ToolResult,
  type CapabilityName,
  type ChangedDomain,
  type SideEffectClass,
  type ToolCall,
  type ToolExecutor,
  type TurnContext,
} from '@platform/contracts';
import {COLLECTOR_KEY, type TurnCollector} from './envelope-hook.js';

/** Platform-owned metadata the envelope needs but agentback's @tool doesn't carry. */
export interface CapabilityMeta {
  sideEffect: SideEffectClass;
  changedDomains: ChangedDomain[];
}

/** Resolves a capability's envelope metadata — built from the CapabilityContract, not hardcoded. */
export type CapabilityMetaSource = (capability: CapabilityName) => CapabilityMeta;

/**
 * A dispatch outcome. When agentback refuses a `confirm:` tool it throws with code
 * `confirmation_required` and a single-use token; the executor surfaces that as `pendingConfirmation`
 * so the platform loop can run the policy `approval` gate and retry (ADR-021 confirm → approval).
 */
export interface DispatchResult {
  result: ToolResult;
  pendingConfirmation?: {token: string};
}

const CONFIRMATION_REQUIRED = 'confirmation_required';
const MUTATING = new Set<SideEffectClass>(['write', 'external', 'payment']);
const READ_META: CapabilityMeta = {sideEffect: 'read', changedDomains: ['none']};

/** Error → envelope error fields. agentback throws AgentError-shaped errors. */
function toErrorFields(err: unknown): {code: string; message: string; retryable: boolean} {
  const e = err as {code?: string; message?: string; retryable?: boolean};
  return {
    code: e.code ?? 'internal_error',
    message: e.message ?? String(err),
    retryable: e.retryable ?? false,
  };
}

export class PlatformToolExecutor implements ToolExecutor {
  constructor(
    private readonly server: MCPServer,
    private readonly parent: Context,
    private readonly metaSource: CapabilityMetaSource,
  ) {}

  /** Canonical port: execute one proposed call and return the synthesized ToolResult. */
  async execute(call: ToolCall, ctx: TurnContext): Promise<ToolResult> {
    return (await this.dispatch(call, ctx)).result;
  }

  /**
   * Like {@link execute} but also surfaces a pending `confirm:` token so the platform loop can run the
   * approval gate and retry the identical call.
   */
  async dispatch(call: ToolCall, ctx: TurnContext): Promise<DispatchResult> {
    const meta = this.metaSource(call.capability) ?? READ_META;
    const collector: TurnCollector = {
      evidence: [],
      metrics: {},
      turnId: ctx.turnId,
      toolCallId: call.toolCallId,
    };

    // Bind the collector on a child context; callTool builds its request child from it, so the
    // dispatch hook finds the collector via the context chain.
    const dispatchCtx = new Context(this.parent, `tool:${call.toolCallId}`);
    dispatchCtx.bind(COLLECTOR_KEY).to(collector);

    const stateChanging = MUTATING.has(meta.sideEffect);
    const metrics = () => ({
      latencyMs: collector.metrics.latencyMs ?? 0,
      retries: 0,
      costUsd: 0,
      idempotentReplay: false,
    });

    try {
      const output = await this.server.callTool(call.capability, call.input, {ctx: dispatchCtx});
      return {
        result: ToolResult.parse({
          toolCallId: call.toolCallId,
          capability: call.capability,
          ok: true,
          output,
          sideEffect: meta.sideEffect,
          stateChanged: stateChanging,
          changedDomains: meta.changedDomains,
          evidence: collector.evidence,
          metrics: metrics(),
          error: null,
        }),
      };
    } catch (err) {
      const fields = toErrorFields(err);
      const token = (err as {confirmationToken?: string}).confirmationToken;
      return {
        result: ToolResult.parse({
          toolCallId: call.toolCallId,
          capability: call.capability,
          ok: false,
          output: null,
          sideEffect: meta.sideEffect,
          stateChanged: false,
          changedDomains: [],
          evidence: collector.evidence,
          metrics: metrics(),
          error: fields,
        }),
        ...(fields.code === CONFIRMATION_REQUIRED && token ? {pendingConfirmation: {token}} : {}),
      };
    }
  }
}

/** Build a CapabilityMetaSource from a lookup of pinned CapabilityContracts. */
export function metaSourceFrom(
  lookup: (name: CapabilityName) => {sideEffect: SideEffectClass; changedDomains: ChangedDomain[]} | undefined,
): CapabilityMetaSource {
  return name => {
    const c = lookup(name);
    return c ? {sideEffect: c.sideEffect, changedDomains: c.changedDomains} : READ_META;
  };
}
