import {describe, it, expect} from 'vitest';
import {CapabilityName, SideEffectClass} from './capability.js';
import {ToolResult, ToolCall} from './agent-runtime.js';

describe('@hermes-one/contracts agent-runtime', () => {
  it('accepts a well-formed domain.resource.action capability name', () => {
    expect(CapabilityName.parse('appointment.booking.create')).toBe(
      'appointment.booking.create',
    );
  });

  it('rejects a malformed capability name', () => {
    expect(() => CapabilityName.parse('BookingCreate')).toThrow();
    expect(() => CapabilityName.parse('appointment.booking')).toThrow();
  });

  it('pins the canonical SideEffectClass enum', () => {
    expect(SideEffectClass.options).toEqual([
      'none',
      'read',
      'write',
      'external',
      'payment',
    ]);
  });

  it('round-trips a ToolResult envelope through JSON unchanged (Temporal payload safety)', () => {
    const envelope = {
      toolCallId: 'tc_1',
      capability: 'appointment.booking.create',
      ok: true,
      output: {bookingId: 'bk_1'},
      sideEffect: 'write',
      stateChanged: true,
      changedDomains: ['appointment', 'conversation'],
      evidence: [],
      metrics: {latencyMs: 12, retries: 0, costUsd: 0, idempotentReplay: false},
      error: null,
    };
    const parsed = ToolResult.parse(envelope);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(envelope);
  });

  it('rejects a ToolCall missing its idempotency key', () => {
    expect(() =>
      ToolCall.parse({
        toolCallId: 'tc_1',
        capability: 'appointment.slot.read',
        input: {},
        proposedAt: '2026-07-11T00:00:00.000Z',
      }),
    ).toThrow();
  });
});
