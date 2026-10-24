// Turn-scoped durable identity for the deterministic rail's side effects: the derived turn identity
// (and with it the idempotency key) must cover the per-run INVOCATION sequence. Without it two
// rule-driven invocations of one capability with equal keyFields in a run derived the same key, so the
// second side effect silently deduped — while a Temporal retry of the SAME invocation must still
// re-derive the identical key (exactly-once under at-least-once delivery).
import {describe, expect, it} from 'vitest';
import type {
  CapabilityInvoker,
  CapabilityLookup,
} from '@hermes-one/capability-contract';
import type {CapabilityContract, ToolCall} from '@hermes-one/contracts';
import {
  createCapabilityActivities,
  type InvokeCapabilityArgs,
} from './capability-activities.js';

const CONTRACT = {
  name: 'messaging.reply.send',
  idempotency: {keyFields: ['to']},
} as unknown as CapabilityContract;
const lookup: CapabilityLookup = () => CONTRACT;

function capture() {
  const invocations: {call: ToolCall; turnId: string}[] = [];
  const invoker = {
    invoke: async (call: ToolCall, ctx: {turnId: string}) => {
      invocations.push({call, turnId: ctx.turnId});
      return {ok: true, output: {providerMessageId: 'pm_1'}};
    },
  } as unknown as CapabilityInvoker;
  return {invocations, activities: createCapabilityActivities(invoker, lookup)};
}

const BASE: InvokeCapabilityArgs = {
  capability: 'messaging.reply.send',
  input: {to: '+15550001111', body: 'we missed your call'},
  tenantId: 'tnt_spec',
  correlationId: 'wf-missed-call-abc-123',
  invokeSeq: 0,
};

describe('invokeCapability derived turn identity', () => {
  it('a Temporal retry of the SAME invocation re-derives the identical idempotency key + turn identity', async () => {
    const {invocations, activities} = capture();
    await activities.invokeCapability(BASE);
    await activities.invokeCapability(BASE);
    expect(invocations[1].turnId).toBe(invocations[0].turnId);
    expect(invocations[1].call.idempotencyKey).toBe(
      invocations[0].call.idempotencyKey,
    );
    expect(invocations[1].call.toolCallId).toBe(invocations[0].call.toolCallId);
  });

  it('a second invocation in the same run (same capability, equal keyFields) derives a DISTINCT key', async () => {
    const {invocations, activities} = capture();
    await activities.invokeCapability(BASE);
    // Second rule-driven visit: identical capability + input — only the workflow's invocation seq advances.
    await activities.invokeCapability({...BASE, invokeSeq: 1});
    expect(invocations[1].turnId).not.toBe(invocations[0].turnId);
    expect(invocations[1].call.idempotencyKey).not.toBe(
      invocations[0].call.idempotencyKey,
    );
    expect(invocations[1].call.toolCallId).not.toBe(
      invocations[0].call.toolCallId,
    );
  });
});
