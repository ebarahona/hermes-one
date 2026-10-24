// The mock LLM's scripted answers: what the agent tests rely on when no real model is configured.
import {describe, expect, it} from 'vitest';
import {respond} from './mock-llm.js';

const SLOT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'appointment_slot_read',
    parameters: {required: ['date'], properties: {date: {type: 'string'}}},
  },
};
const ask = (text: string) => [
  {role: 'system', content: `Objective: help the caller (inbound: ${text})`},
  {role: 'user', content: `help the caller (inbound: ${text})`},
];

describe('mock-llm respond()', () => {
  it('calls the slot tool for a scheduling ask, filling the date from the message', () => {
    const out = respond({
      messages: ask('what appointment slots do you have open on 2026-07-20?'),
      tools: [SLOT_TOOL],
    });
    expect(out.toolCall).toEqual({
      name: 'appointment_slot_read',
      arguments: {date: '2026-07-20'},
    });
    expect(out.content).toBeNull();
  });

  it('replies without a tool call when the message is not about scheduling', () => {
    const out = respond({
      messages: ask('there is a burning smell near the panel'),
      tools: [SLOT_TOOL],
    });
    expect(out.toolCall).toBeUndefined();
    expect(out.content).toMatch(/follow up/);
  });

  it('ignores scheduling words in the objective; only the customer message counts', () => {
    const out = respond({
      messages: [
        {
          role: 'system',
          content: 'Objective: offer to schedule a service visit',
        },
        {
          role: 'user',
          content:
            'Offer to schedule a service visit. (inbound: {"text":"I smell smoke near the panel"})',
        },
      ],
      tools: [SLOT_TOOL],
    });
    expect(out.toolCall).toBeUndefined();
  });

  it('replies without a tool call when no tools are offered', () => {
    const out = respond({messages: ask('can I book a visit?')});
    expect(out.toolCall).toBeUndefined();
  });

  it('finishes with the tool results after a tool step', () => {
    const out = respond({
      messages: [
        {role: 'system', content: 'x'},
        {
          role: 'user',
          content:
            'Results so far: appointment.slot.read={"slots":["09:15"]}. Continue or finish.',
        },
      ],
      tools: [SLOT_TOOL],
    });
    expect(out.toolCall).toBeUndefined();
    expect(out.content).toContain('"09:15"');
  });
});
