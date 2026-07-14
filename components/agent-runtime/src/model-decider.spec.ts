// Unit-test the model→Decision mapping with a fake SingleStepModel (no live LLM): a tool call maps to
// a platform ToolCall (provider name → capability); no tool call finishes the turn.
import {describe, it, expect} from 'vitest';
import type {CapabilityName} from '@platform/contracts';
import {createModelDecider, type DeciderTool} from './model-decider.js';
import {fakeModel, noUsage} from './_test-fixtures.js';

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
        toolCalls: [{name: 'appointment_slot_read', arguments: {date: '2026-07-12'}}],
        usage: noUsage,
      }),
      objective: 'help',
      tools: TOOLS,
      now: () => 1_000,
    });

    const decision = await decider.propose(0, []);
    expect(decision.kind).toBe('tool');
    if (decision.kind !== 'tool') throw new Error('expected tool');
    expect(decision.call.capability).toBe('appointment.slot.read');
    expect(decision.call.input).toEqual({date: '2026-07-12'});
    expect(decision.call.idempotencyKey).toContain('appointment.slot.read');
  });

  it('finishes the turn when the model returns text and no tool call', async () => {
    const decider = createModelDecider({
      model: fakeModel({text: 'All set — Tuesday works.', toolCalls: [], usage: noUsage}),
      objective: 'help',
      tools: TOOLS,
    });
    const decision = await decider.propose(0, []);
    expect(decision.kind).toBe('done');
    if (decision.kind !== 'done') throw new Error('expected done');
    expect(decision.reply).toBe('All set — Tuesday works.');
  });

  it('ignores a tool call for an unknown tool (finishes instead)', async () => {
    const decider = createModelDecider({
      model: fakeModel({text: 'hmm', toolCalls: [{name: 'unknown_tool', arguments: {}}], usage: noUsage}),
      objective: 'help',
      tools: TOOLS,
    });
    const decision = await decider.propose(0, []);
    expect(decision.kind).toBe('done');
  });
});
