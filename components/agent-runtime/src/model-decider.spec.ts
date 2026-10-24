// Unit-test the model→Decision mapping with a fake SingleStepModel (no live LLM): a tool call maps to
// a platform ToolCall (provider name → capability); no tool call finishes the turn.
import {describe, it, expect} from 'vitest';
import type {CapabilityName, TurnId} from '@hermes-one/contracts';
import type {ModelCompleteRequest} from '@hermes-one/model-client';
import {createModelDecider, type DeciderTool} from './model-decider.js';
import {fakeModel, noUsage} from './_test-fixtures.js';

const TURN = 'trn_decider_spec' as TurnId;

const TOOLS: DeciderTool[] = [
  {
    toolName: 'appointment_slot_read',
    capability: 'appointment.slot.read' as CapabilityName,
    description: 'List open slots.',
    parameters: {type: 'object', properties: {date: {type: 'string'}}},
  },
];

describe('model-backed decider', () => {
  it('maps a model tool call to a platform ToolCall (provider name → capability)', async () => {
    const decider = createModelDecider({
      model: fakeModel({
        text: '',
        toolCalls: [
          {name: 'appointment_slot_read', arguments: {date: '2026-07-12'}},
        ],
        usage: noUsage,
      }),
      objective: 'help',
      tools: TOOLS,
      turnId: TURN,
      now: () => 1_000,
    });

    const decision = await decider.propose(0, []);
    expect(decision.kind).toBe('tool');
    if (decision.kind !== 'tool') throw new Error('expected tool');
    expect(decision.call.capability).toBe('appointment.slot.read');
    expect(decision.call.input).toEqual({date: '2026-07-12'});
    expect(decision.call.idempotencyKey).toContain('appointment.slot.read');
  });

  it('derives toolCallIds deterministically from (turnId, step) — replay-stable, turn-disjoint', async () => {
    const make = (turnId: TurnId) =>
      createModelDecider({
        model: fakeModel({
          text: '',
          toolCalls: [
            {name: 'appointment_slot_read', arguments: {date: '2026-07-12'}},
          ],
          usage: noUsage,
        }),
        objective: 'help',
        tools: TOOLS,
        turnId,
        now: () => 1_000,
      });
    const callId = async (turnId: TurnId, step: number) => {
      const d = await make(turnId).propose(step, []);
      if (d.kind !== 'tool') throw new Error('expected tool');
      return d.call.toolCallId;
    };

    // (a) Same (turnId, step) re-derives the IDENTICAL id (a Temporal retry collapses on replay).
    const a0 = await callId(TURN, 0);
    expect(a0).toMatch(/^tc_[0-9a-f]{24}$/);
    expect(await callId(TURN, 0)).toBe(a0);

    // Steps within one turn are distinct.
    expect(await callId(TURN, 1)).not.toBe(a0);

    // (b) Two DIFFERENT turns yield disjoint ids — no cross-turn collision (was wall-clock global).
    expect(await callId('trn_other_turn' as TurnId, 0)).not.toBe(a0);
  });

  it('finishes the turn when the model returns text and no tool call', async () => {
    const decider = createModelDecider({
      model: fakeModel({
        text: 'All set — Tuesday works.',
        toolCalls: [],
        usage: noUsage,
      }),
      objective: 'help',
      tools: TOOLS,
      turnId: TURN,
    });
    const decision = await decider.propose(0, []);
    expect(decision.kind).toBe('done');
    if (decision.kind !== 'done') throw new Error('expected done');
    expect(decision.reply).toBe('All set — Tuesday works.');
  });

  it('ignores a tool call for an unknown tool (finishes instead)', async () => {
    const decider = createModelDecider({
      model: fakeModel({
        text: 'hmm',
        toolCalls: [{name: 'unknown_tool', arguments: {}}],
        usage: noUsage,
      }),
      objective: 'help',
      tools: TOOLS,
      turnId: TURN,
    });
    const decision = await decider.propose(0, []);
    expect(decision.kind).toBe('done');
  });

  it("sends the engine's model id and temperature on each model call", async () => {
    const requests: ModelCompleteRequest[] = [];
    const decider = createModelDecider({
      model: {
        complete: async req => {
          requests.push(req);
          return {text: 'done', toolCalls: [], usage: noUsage};
        },
      },
      modelId: 'engine-model',
      temperature: 0.4,
      objective: 'help',
      tools: TOOLS,
      turnId: TURN,
    });
    await decider.propose(0, []);
    await decider.propose(1, []);
    expect(requests.map(r => [r.model, r.temperature])).toEqual([
      ['engine-model', 0.4],
      ['engine-model', 0.4],
    ]);
  });
});
