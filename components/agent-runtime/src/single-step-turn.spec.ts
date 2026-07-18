// The platform single-step turn (ADR-021): the loop drives one decide→execute per step; the agentback
// confirm: round-trip maps to a policy `approval`; and confirm: tools never project to an autonomous
// agent (so the platform MUST drive them itself). Executor-level tests inspect the ToolResult; turn-level
// tests drive runTurn and inspect the TurnResult.
import {describe, it, expect} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {MCPBindings, MCP_DISPATCH_HOOK_TAG, selectTools, type MCPServer} from '@agentback/mcp';
import type {Context} from '@agentback/context';
import {createAgentPlaneApp} from '@platform-internal/agentback-runtime';
import {
  PlatformToolExecutor,
  createEnvelopeHook,
  type CapabilityMeta,
  type CapabilityMetaSource,
} from '@platform-internal/tool-executor';
import type {CapabilityName, ToolCall, TurnContext} from '@platform/contracts';
import {runTurn, type Decider, type TurnLedger} from './index.js';
import {testTurnRequest, noUsage, FIXED_NOW} from './_test-fixtures.js';
import type {CompiledPolicyPlan, PolicyRuntime} from '@platform/contracts';

// A trivial always-allow policy runtime — enough to exercise pre/post-gate decision recording without
// pulling the policy compiler into this unit test (the real runtime is covered in policy-dsl specs).
const allowRuntime: PolicyRuntime = {
  evaluatePreGates: () => ({outcome: 'allow', policyRuleId: '<default>', reason: 'ok', decidedAt: FIXED_NOW}),
  evaluatePostGates: () => ({outcome: 'allow', policyRuleId: '<default>', reason: 'ok', decidedAt: FIXED_NOW}),
  toVoters: () => [],
};
// A pre-gate that always hands off — drives the turn to outcome='handoff' at step 0.
const handoffRuntime: PolicyRuntime = {
  evaluatePreGates: () => ({outcome: 'handoff', policyRuleId: 'r_needs_human', reason: 'needs a human', decidedAt: FIXED_NOW}),
  evaluatePostGates: () => ({outcome: 'allow', policyRuleId: '<default>', reason: 'ok', decidedAt: FIXED_NOW}),
  toVoters: () => [],
};
const emptyPolicyPlan = {} as CompiledPolicyPlan;

const META: Record<string, CapabilityMeta> = {
  'appointment.slot.read': {sideEffect: 'read', changedDomains: ['none']},
  'appointment.booking.create': {sideEffect: 'write', changedDomains: ['appointment', 'conversation']},
};
const metaSource: CapabilityMetaSource = n => META[n] ?? {sideEffect: 'read', changedDomains: ['none']};
const execCtx = {turnId: 'trn_exec'} as unknown as TurnContext;

function boot() {
  const app = createAgentPlaneApp({fixtures: true});
  app.bind('platform.hook.envelope').to(createEnvelopeHook()).tag(MCP_DISPATCH_HOOK_TAG);
  return app;
}

function call(capability: string, input: Record<string, unknown>): ToolCall {
  return {
    toolCallId: `tc_${capability}` as ToolCall['toolCallId'],
    capability: capability as CapabilityName,
    input,
    idempotencyKey: `idem-${capability}`,
    proposedAt: '2026-07-11T00:00:00.000Z' as ToolCall['proposedAt'],
  };
}

const bookingInput = {slot: '2026-07-12T14:00:00-05:00', customer: 'Ada'};

const stepThen = (first: ToolCall): Decider => ({
  propose: step =>
    step === 0 ? {kind: 'tool', call: first, usage: noUsage} : {kind: 'done', usage: noUsage},
});

describe('platform-owned single-step loop (ADR-021)', () => {
  it('drives one decide→execute per step and composes from evidence', async () => {
    await using t = await createTestApp(boot);
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
    const exec = new PlatformToolExecutor(server, t.app as unknown as Context, metaSource);

    const result = await runTurn(testTurnRequest('list slots'), {
      executor: exec,
      decider: stepThen(call('appointment.slot.read', {date: '2026-07-12'})),
      clock: {nowMs: () => 0},
    });

    expect(result.outcome).toBe('replied');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.evidence.length).toBeGreaterThanOrEqual(1);
    expect(result.evidence[0].turnId).toBe('trn_test1'); // evidence is stamped with the real turn id
  });
});

describe('confirm: round-trip', () => {
  it('agentback refuses the first call with a single-use token, executes the identical retry', async () => {
    await using t = await createTestApp(boot);
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);

    let token = '';
    try {
      await server.callTool('appointment.booking.create', bookingInput);
      expect.fail('expected confirmation_required');
    } catch (e) {
      expect((e as {code?: string}).code).toBe('confirmation_required');
      token = (e as {confirmationToken?: string}).confirmationToken ?? '';
    }
    expect(token).toBeTruthy();
    const output = await server.callTool('appointment.booking.create', {...bookingInput, confirmationToken: token});
    expect(output).toMatchObject({slot: bookingInput.slot});
  });

  it('executor surfaces the pending confirmation, then the retry state-changes', async () => {
    await using t = await createTestApp(boot);
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
    const exec = new PlatformToolExecutor(server, t.app as unknown as Context, metaSource);

    const first = await exec.dispatch(call('appointment.booking.create', bookingInput), execCtx);
    expect(first.pendingConfirmation?.token).toBeTruthy();
    expect(first.result.stateChanged).toBe(false);

    const retry = await exec.dispatch(
      {...call('appointment.booking.create', bookingInput), input: {...bookingInput, confirmationToken: first.pendingConfirmation!.token}},
      execCtx,
    );
    expect(retry.result.ok).toBe(true);
    expect(retry.result.stateChanged).toBe(true);
    expect(retry.result.changedDomains).toEqual(['appointment', 'conversation']);
  });

  it('the turn drives approval → retry to a replied outcome', async () => {
    await using t = await createTestApp(boot);
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
    const exec = new PlatformToolExecutor(server, t.app as unknown as Context, metaSource);

    const result = await runTurn(testTurnRequest('book it'), {
      executor: exec,
      decider: stepThen(call('appointment.booking.create', bookingInput)),
      approve: () => true,
      clock: {nowMs: () => 0},
    });
    expect(result.outcome).toBe('replied');
    expect(result.toolCalls.map(c => c.capability)).toContain('appointment.booking.create');
  });

  it('a denied approval hands off and records the approval decision (side effect unexecuted)', async () => {
    await using t = await createTestApp(boot);
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
    const exec = new PlatformToolExecutor(server, t.app as unknown as Context, metaSource);

    const result = await runTurn(testTurnRequest('book it'), {
      executor: exec,
      decider: stepThen(call('appointment.booking.create', bookingInput)),
      approve: () => false,
      clock: {nowMs: () => 0},
    });
    expect(result.outcome).toBe('handoff');
    expect(result.gateDecision?.outcome).toBe('approval');
  });
});

describe('durable turn ledger (Tier 2)', () => {
  it('emits tool executions, evidence, and every gate decision to onPersist', async () => {
    await using t = await createTestApp(boot);
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
    const exec = new PlatformToolExecutor(server, t.app as unknown as Context, metaSource);

    let captured: TurnLedger | undefined;
    const result = await runTurn(testTurnRequest('list slots'), {
      executor: exec,
      decider: stepThen(call('appointment.slot.read', {date: '2026-07-12'})),
      policy: {plan: emptyPolicyPlan, runtime: allowRuntime},
      onPersist: async l => { captured = l; },
      clock: {nowMs: () => 0},
    });

    expect(result.outcome).toBe('replied');
    expect(captured).toBeDefined();
    expect(captured!.turnId).toBe('trn_test1');
    expect(captured!.tenantId).toBe('tnt_test');
    expect(captured!.correlationId).toBe('corr_test');

    // one executed tool call, paired with its result by id
    expect(captured!.toolExecutions).toHaveLength(1);
    const te = captured!.toolExecutions[0];
    expect(te.result.toolCallId).toBe(te.call.toolCallId);
    expect(te.call.capability).toBe('appointment.slot.read');
    expect(te.result.ok).toBe(true);

    // evidence flowed through
    expect(captured!.evidence.length).toBeGreaterThanOrEqual(1);

    // pre-gate (allow) + post-gate (allow) recorded, with sites + deterministic ids
    const sites = captured!.policyDecisions.map(d => d.site);
    expect(sites).toContain('preGate');
    expect(sites).toContain('postGate');
    expect(captured!.policyDecisions.every(d => d.decisionId.startsWith('pld_'))).toBe(true);
  });

  it('emits an initial handoff request when the turn hands off', async () => {
    await using t = await createTestApp(boot);
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
    const exec = new PlatformToolExecutor(server, t.app as unknown as Context, metaSource);

    let captured: TurnLedger | undefined;
    const result = await runTurn(testTurnRequest('book it'), {
      executor: exec,
      decider: stepThen(call('appointment.slot.read', {date: '2026-07-12'})),
      policy: {plan: emptyPolicyPlan, runtime: handoffRuntime},
      onPersist: async l => { captured = l; },
      clock: {nowMs: () => 0},
    });

    expect(result.outcome).toBe('handoff');
    expect(captured!.handoff).toBeDefined();
    expect(captured!.handoff!.reason).toBe('policy-required'); // policy gate → policy-required
    expect(captured!.handoff!.triggeringTurnId).toBe('trn_test1');
    expect(captured!.handoff!.conversationId).toBe('cnv_test');
    expect(captured!.handoff!.handoffId).toMatch(/^hof_/);
    expect(captured!.handoff!.summary).toBe('needs a human');
    // pre-gate stopped before execute → no tool executions
    expect(captured!.toolExecutions).toHaveLength(0);
  });

  it('omits handoff from the ledger on a normal replied turn', async () => {
    await using t = await createTestApp(boot);
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
    const exec = new PlatformToolExecutor(server, t.app as unknown as Context, metaSource);

    let captured: TurnLedger | undefined;
    await runTurn(testTurnRequest('list slots'), {
      executor: exec,
      decider: stepThen(call('appointment.slot.read', {date: '2026-07-12'})),
      policy: {plan: emptyPolicyPlan, runtime: allowRuntime},
      onPersist: async l => { captured = l; },
      clock: {nowMs: () => 0},
    });
    expect(captured!.handoff).toBeUndefined();
  });

  it('emits identical decision ids across replays (deterministic, no random/clock)', async () => {
    const runOnce = async (): Promise<TurnLedger> => {
      await using t = await createTestApp(boot);
      const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
      const exec = new PlatformToolExecutor(server, t.app as unknown as Context, metaSource);
      let captured: TurnLedger | undefined;
      await runTurn(testTurnRequest('list slots'), {
        executor: exec,
        decider: stepThen(call('appointment.slot.read', {date: '2026-07-12'})),
        policy: {plan: emptyPolicyPlan, runtime: allowRuntime},
        onPersist: async l => { captured = l; },
        clock: {nowMs: () => 0},
      });
      return captured!;
    };
    const a = await runOnce();
    const b = await runOnce();
    expect(a.policyDecisions.map(d => d.decisionId)).toEqual(b.policyDecisions.map(d => d.decisionId));
  });
});

describe('confirm: tools never project to an autonomous agent', () => {
  it('excludes confirm: tools from selectTools, and throws if one is named', async () => {
    await using t = await createTestApp(boot);
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
    const tools = server.listTools();

    const projected = selectTools(tools).map(x => x.meta.name);
    expect(projected).toContain('appointment.slot.read');
    expect(projected).not.toContain('appointment.booking.create');
    expect(() => selectTools(tools, {include: ['appointment.booking.create']})).toThrow(/confirm:/);
  });
});

describe('bounded post-gate repair (ADR-019, A2)', () => {
  // A composer that HONORS the repair instruction (a model-backed composer would); used to prove the
  // repaired reply is delivered when the re-gate then allows it.
  const repairingComposer = (ctx: TurnContext, _obj: string, fallback?: string, instruction?: string) =>
    instruction ? `repaired(${instruction}): ${fallback ?? 'ok'}` : (fallback ?? 'ok');

  // Post-gate: 'repair' on the first (un-repaired) draft, 'allow' once the reply is repaired.
  const repairThenAllow: PolicyRuntime = {
    evaluatePreGates: () => ({outcome: 'allow', policyRuleId: '<default>', reason: 'ok', decidedAt: FIXED_NOW}),
    evaluatePostGates: (_p, c) => {
      const reply = String((c as {draftReply?: string}).draftReply ?? '');
      return reply.startsWith('repaired(')
        ? {outcome: 'allow', policyRuleId: 'r_tone', reason: 'repaired ok', decidedAt: FIXED_NOW}
        : {outcome: 'repair', policyRuleId: 'r_tone', reason: 'soften tone', detail: {repairInstruction: 'soften tone'}, decidedAt: FIXED_NOW};
    },
    toVoters: () => [],
  };

  it('re-composes ONCE under the repair instruction and delivers the repaired reply when it passes', async () => {
    let captured: TurnLedger | undefined;
    const result = await runTurn(testTurnRequest('reply please'), {
      executor: {dispatch: async () => ({result: {toolCallId: 'tc_x', capability: 'noop' as CapabilityName, ok: true, output: {}, sideEffect: 'read', stateChanged: false, changedDomains: [], evidence: [], metrics: {latencyMs: 0, retries: 0, costUsd: 0, idempotentReplay: false}, error: null}})} as never,
      decider: {propose: () => ({kind: 'done', reply: 'blunt reply', usage: noUsage})},
      policy: {plan: emptyPolicyPlan, runtime: repairThenAllow},
      compose: repairingComposer,
      onPersist: async l => { captured = l; },
      clock: {nowMs: () => 0},
    });
    expect(result.outcome).toBe('replied');
    expect(result.reply).toBe('repaired(soften tone): blunt reply');
    // both post-gate evaluations recorded (repair, then allow) — the boundary is auditable
    const posts = captured!.policyDecisions.filter(d => d.site === 'postGate');
    expect(posts.map(d => d.decision.outcome)).toEqual(['repair', 'allow']);
  });

  it('escalates to a human when the (default, non-reshaping) composer cannot satisfy the repair', async () => {
    let captured: TurnLedger | undefined;
    const result = await runTurn(testTurnRequest('reply please'), {
      executor: {dispatch: async () => ({result: {toolCallId: 'tc_x', capability: 'noop' as CapabilityName, ok: true, output: {}, sideEffect: 'read', stateChanged: false, changedDomains: [], evidence: [], metrics: {latencyMs: 0, retries: 0, costUsd: 0, idempotentReplay: false}, error: null}})} as never,
      decider: {propose: () => ({kind: 'done', reply: 'blunt reply', usage: noUsage})},
      policy: {plan: emptyPolicyPlan, runtime: repairThenAllow}, // default composer never yields "repaired(" → stays repair
      onPersist: async l => { captured = l; },
      clock: {nowMs: () => 0},
    });
    expect(result.outcome).toBe('handoff');
    expect(captured!.handoff?.reason).toBe('policy-required');
  });
});

describe('provider onNoProvider:handoff routes the turn to a human (PE6)', () => {
  it('a handoff-disposition dispatch ends the turn in handoff with error-escalation', async () => {
    let captured: TurnLedger | undefined;
    // The stub echoes the proposed call's id, exactly as the real executor does — so the failed
    // result pairs into the ledger's toolExecutions for audit.
    const failed = (c: ToolCall) => ({toolCallId: c.toolCallId, capability: c.capability, ok: false, output: null, sideEffect: 'read' as const, stateChanged: false, changedDomains: [], evidence: [], metrics: {latencyMs: 0, retries: 0, costUsd: 0, idempotentReplay: false}, error: {code: 'no_provider', message: 'all providers unhealthy', retryable: false}});
    const result = await runTurn(testTurnRequest('book me'), {
      executor: {dispatch: async (c: ToolCall) => ({result: failed(c), pendingHandoff: {reason: 'all providers unhealthy'}})} as never,
      decider: stepThen(call('appointment.slot.read', {date: '2026-07-12'})),
      policy: {plan: emptyPolicyPlan, runtime: allowRuntime},
      onPersist: async l => { captured = l; },
      clock: {nowMs: () => 0},
    });
    expect(result.outcome).toBe('handoff');
    expect(captured!.handoff?.reason).toBe('error-escalation');
    expect(captured!.handoff?.summary).toContain('No provider available for appointment.slot.read');
    // the failed tool result is still on the ledger for audit
    expect(captured!.toolExecutions).toHaveLength(1);
    expect(captured!.toolExecutions[0].result.ok).toBe(false);
  });
});
