// ADR-018 envelope synthesis. The executor wraps agentback's callTool and builds the ToolResult AROUND
// the unwrapped result: sideEffect/changedDomains from capability metadata, evidence/metrics from the
// dispatch hook.
import {describe, it, expect} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {
  MCPBindings,
  MCP_DISPATCH_HOOK_TAG,
  type MCPServer,
} from '@agentback/mcp';
import type {Context} from '@agentback/context';
import {createAgentPlaneApp} from '@platform-internal/agentback-runtime';
import type {CapabilityName, ToolCall, TurnContext} from '@platform/contracts';
import {PlatformToolExecutor, type CapabilityMeta, type CapabilityMetaSource} from './executor.js';
import {createEnvelopeHook} from './envelope-hook.js';

const META: Record<string, CapabilityMeta> = {
  'appointment.slot.read': {sideEffect: 'read', changedDomains: []},
  'appointment.booking.create': {
    sideEffect: 'write',
    changedDomains: ['appointment', 'conversation'],
  },
};
const metaSource: CapabilityMetaSource = name => META[name] ?? {sideEffect: 'read', changedDomains: ['none']};
const ctx = {turnId: 'trn_t3'} as unknown as TurnContext;

// Deterministic hook clock/ids so evidence + metrics are assertable.
function bootFactory() {
  let tick = 0;
  return () => {
    const app = createAgentPlaneApp({fixtures: true});
    app
      .bind('platform.hook.envelope')
      .to(
        createEnvelopeHook({
          now: () => (tick += 5),
          isoNow: () => '2026-07-11T00:00:00.000Z',
          newId: () => 'evd_1',
        }),
      )
      .tag(MCP_DISPATCH_HOOK_TAG);
    return app;
  };
}

const readCall: ToolCall = {
  toolCallId: 'tc_read' as ToolCall['toolCallId'],
  capability: 'appointment.slot.read' as CapabilityName,
  input: {date: '2026-07-12'},
  idempotencyKey: 'idem-read-1',
  proposedAt: '2026-07-11T00:00:00.000Z' as ToolCall['proposedAt'],
};

describe('ToolResult envelope synthesis (ADR-018)', () => {
  it("synthesizes a full envelope around agentback's unwrapped result", async () => {
    await using t = await createTestApp(bootFactory());
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
    const exec = new PlatformToolExecutor(server, t.app as unknown as Context, metaSource);

    const result = await exec.execute(readCall, ctx);

    expect(result.ok).toBe(true);
    // output is agentback's unwrapped, output-validated value
    expect(result.output).toMatchObject({slots: expect.any(Array)});
    // from capability metadata
    expect(result.sideEffect).toBe('read');
    expect(result.stateChanged).toBe(false);
    expect(result.changedDomains).toEqual([]);
    // from the dispatch hook
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      kind: 'tool-output',
      capability: 'appointment.slot.read',
      // Canonical tool-output stamping: a capability the
      // PLATFORM invoked yields authoritative/trusted evidence — ADR-009 compose grounds only on
      // trusted evidence, so this is what lets the agent state what it fetched.
      source: 'authoritative',
      trusted: true,
    });
    expect(result.metrics.latencyMs).toBe(5);
    expect(result.error).toBeNull();
  });

  it('derives replay-stable, turn-scoped evidence ids by default (no injected newId)', async () => {
    // Default hook: id = evd_<sha256(turnId:toolCallId:ordinal)> — no per-process counter.
    const boot = () => {
      const app = createAgentPlaneApp({fixtures: true});
      app.bind('platform.hook.envelope').to(createEnvelopeHook()).tag(MCP_DISPATCH_HOOK_TAG);
      return app;
    };
    await using t = await createTestApp(boot);
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
    const exec = new PlatformToolExecutor(server, t.app as unknown as Context, metaSource);

    const ctxA = {turnId: 'trn_a'} as unknown as TurnContext;
    const ctxB = {turnId: 'trn_b'} as unknown as TurnContext;

    // (a) Same turn, same call, re-executed (Temporal retry) → IDENTICAL id: replay collapses.
    const first = await exec.execute(readCall, ctxA);
    const again = await exec.execute(readCall, ctxA);
    expect(first.evidence[0].id).toMatch(/^evd_[0-9a-f]{24}$/);
    expect(again.evidence[0].id).toBe(first.evidence[0].id);

    // (b) A DIFFERENT turn (any worker/replica) can never mint the same id.
    const otherTurn = await exec.execute(readCall, ctxB);
    expect(otherTurn.evidence[0].id).not.toBe(first.evidence[0].id);

    // A different tool call within the same turn is also disjoint.
    const otherCall = await exec.execute(
      {...readCall, toolCallId: 'tc_read2' as ToolCall['toolCallId']},
      ctxA,
    );
    expect(otherCall.evidence[0].id).not.toBe(first.evidence[0].id);
  });

  it('maps a dispatch failure to ok:false with an error envelope', async () => {
    await using t = await createTestApp(bootFactory());
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
    const exec = new PlatformToolExecutor(server, t.app as unknown as Context, metaSource);

    const bad: ToolCall = {
      ...readCall,
      toolCallId: 'tc_bad' as ToolCall['toolCallId'],
      input: {date: 123 as unknown as string}, // violates input schema
    };
    const result = await exec.execute(bad, ctx);

    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.output).toBeNull();
  });
});
