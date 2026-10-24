// Agent reply delivery (ledger SP4): an `agent` node that declares `deliverReply` sends the turn's
// final, post-gated reply through the SAME capability effect a capability node uses — once, and only
// for a `replied` outcome. A handoff (or any other outcome) sends nothing. The effects stub mirrors the
// workflow host's edge effects: every capability invocation takes the next per-run invocation ordinal,
// which the edge activity folds into the delivery's idempotency key.
import {describe, it, expect} from 'vitest';
import type {
  DefinitionId,
  IsoTimestamp,
  PlanId,
  SemVer,
  WorkflowDefinition,
} from '@hermes-one/contracts';
import {compileWorkflow} from './compile.js';
import {executeCompiledWorkflow, type WorkflowEffects} from './interpreter.js';

const V1 = '1.0.0' as SemVer;
const NOW = '2026-10-24T00:00:00.000Z' as IsoTimestamp;
const ENGINE = {
  definitionId: 'def_engine',
  version: V1,
  contentHash: `sha256:${'a'.repeat(64)}`,
};
const DELIVER = {
  capability: 'messaging.reply.send',
  input: {
    to: {$input: 'from'},
    template: 'agent_reply',
    body: {$agent: 'reply'},
  },
};

function plan(nodes: Record<string, unknown>, entry = 'assist') {
  return compileWorkflow(
    {
      definitionId: 'def_agent_reply_wf' as DefinitionId,
      kind: 'workflow',
      version: V1,
      body: {entry, nodes},
    } as unknown as WorkflowDefinition,
    {compilerVersion: V1, planId: 'pln_wf' as PlanId, compiledAt: NOW},
  );
}

const agentNode = (
  id: string,
  next: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  kind: 'agent',
  agentEngine: ENGINE,
  objective: 'Answer the customer.',
  next,
  ...extra,
});
const END = {id: 'end', kind: 'terminal', outcome: 'completed'};

const singleAgent = plan({
  assist: agentNode('assist', 'end', {deliverReply: DELIVER}),
  end: END,
});

type Turn = {outcome: string; reply?: string};

function makeEffects(turns: Turn[]) {
  const sent: {
    capability: string;
    input: Record<string, unknown>;
    invokeSeq: number;
  }[] = [];
  let invokeSeq = 0;
  let turn = 0;
  const effects: WorkflowEffects = {
    gatherFacts: () => ({}),
    evaluateRule: () => ({outcome: 'default'}),
    invokeCapability: (capability, input) => {
      sent.push({capability, input, invokeSeq: invokeSeq++});
      return {delivered: true};
    },
    runAgentTurn: () => turns[turn++]!,
    now: () => NOW,
  };
  return {effects, sent};
}

const RUN = {input: {channel: 'sms', from: '+15125550100', text: 'hello'}};

describe('agent node reply delivery (deliverReply)', () => {
  it('delivers a replied turn once, with the final reply text bound into the capability input', async () => {
    const {effects, sent} = makeEffects([
      {outcome: 'replied', reply: 'Here is how to do that.'},
    ]);
    const run = await executeCompiledWorkflow(singleAgent, RUN, effects);
    expect(run.path).toEqual(['assist', 'end']);
    expect(run.outcome).toBe('completed');
    expect(sent).toEqual([
      {
        capability: 'messaging.reply.send',
        input: {
          to: '+15125550100',
          template: 'agent_reply',
          body: 'Here is how to do that.',
        },
        invokeSeq: 0,
      },
    ]);
  });

  it('delivers the repaired text when the post-gate repaired the reply', async () => {
    // The turn returns its FINAL post-gated reply; the draft the policy flagged never reaches the workflow.
    const {effects, sent} = makeEffects([
      {outcome: 'replied', reply: 'repaired(soften tone): reply'},
    ]);
    await executeCompiledWorkflow(singleAgent, RUN, effects);
    expect(sent.map(s => s.input.body)).toEqual([
      'repaired(soften tone): reply',
    ]);
  });

  it('sends nothing on a handoff, even when the turn carries text', async () => {
    const {effects, sent} = makeEffects([
      {outcome: 'handoff', reply: 'draft that must not be sent'},
    ]);
    const run = await executeCompiledWorkflow(singleAgent, RUN, effects);
    expect(run.path).toEqual(['assist', 'end']);
    expect(sent).toHaveLength(0);
  });

  it.each(['failed', 'no-action', 'deferred'])(
    'sends nothing on a %s outcome',
    async outcome => {
      const {effects, sent} = makeEffects([{outcome}]);
      await executeCompiledWorkflow(singleAgent, RUN, effects);
      expect(sent).toHaveLength(0);
    },
  );

  it('sends nothing for a replied turn with no reply text', async () => {
    const {effects, sent} = makeEffects([{outcome: 'replied'}]);
    await executeCompiledWorkflow(singleAgent, RUN, effects);
    expect(sent).toHaveLength(0);
  });

  it('sends nothing when the agent node declares no delivery', async () => {
    const noDelivery = plan({assist: agentNode('assist', 'end'), end: END});
    const {effects, sent} = makeEffects([{outcome: 'replied', reply: 'hi'}]);
    await executeCompiledWorkflow(noDelivery, RUN, effects);
    expect(sent).toHaveLength(0);
  });

  it('gives each turn its own invocation ordinal, identical on a deterministic re-execution', async () => {
    // Two agent visits and a template reply in one run: each delivery takes the next ordinal, so two
    // replies to the same recipient with the same template derive distinct idempotency keys, while a
    // re-execution of the same run re-derives the same ordinals (Temporal replay itself is covered by
    // the replay gate).
    const twoTurns = plan(
      {
        first: agentNode('first', 'notice', {deliverReply: DELIVER}),
        notice: {
          id: 'notice',
          kind: 'capability',
          capability: 'messaging.reply.send',
          input: {to: {$input: 'from'}, template: 'notice'},
          next: 'second',
        },
        second: agentNode('second', 'end', {deliverReply: DELIVER}),
        end: END,
      },
      'first',
    );
    const turns = [
      {outcome: 'replied', reply: 'first reply'},
      {outcome: 'replied', reply: 'second reply'},
    ];
    const a = makeEffects(turns);
    const b = makeEffects(turns);
    await executeCompiledWorkflow(twoTurns, RUN, a.effects);
    await executeCompiledWorkflow(twoTurns, RUN, b.effects);
    expect(
      a.sent.map(s => [s.input.template, s.input.body, s.invokeSeq]),
    ).toEqual([
      ['agent_reply', 'first reply', 0],
      ['notice', undefined, 1],
      ['agent_reply', 'second reply', 2],
    ]);
    expect(b.sent).toEqual(a.sent);
  });

  it('rejects a delivery with a malformed capability name at compile time', () => {
    expect(() =>
      plan({
        assist: agentNode('assist', 'end', {
          deliverReply: {capability: 'Not A Capability', input: {}},
        }),
        end: END,
      }),
    ).toThrow();
  });

  it('rejects an unknown $agent binding at compile time', () => {
    expect(() =>
      plan({
        assist: agentNode('assist', 'end', {
          deliverReply: {...DELIVER, input: {body: {$agent: 'replyText'}}},
        }),
        end: END,
      }),
    ).toThrow(/unknown \$agent binding .*replyText/);
  });

  it('rejects a $agent binding on a capability node at compile time', () => {
    expect(() =>
      plan(
        {
          send: {
            id: 'send',
            kind: 'capability',
            capability: 'messaging.reply.send',
            input: {body: {$agent: 'reply'}},
            next: 'end',
          },
          end: END,
        },
        'send',
      ),
    ).toThrow(/only valid on an agent node/);
  });
});
