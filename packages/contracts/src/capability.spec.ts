import {describe, it, expect} from 'vitest';
import {ChangedDomain, KNOWN_CHANGED_DOMAINS} from './capability.js';
import {ToolResult} from './agent-runtime.js';

describe('@platform/contracts ChangedDomain', () => {
  it('accepts every known domain, including none', () => {
    for (const d of KNOWN_CHANGED_DOMAINS)
      expect(ChangedDomain.parse(d)).toBe(d);
    expect(KNOWN_CHANGED_DOMAINS).toContain('none');
  });

  it('accepts a pack-declared custom domain', () => {
    expect(ChangedDomain.parse('work_order')).toBe('work_order');
    expect(ChangedDomain.parse('permit-2')).toBe('permit-2');
  });

  it('rejects empty, uppercase, and non-identifier domains', () => {
    for (const d of ['', 'Appointment', '1domain', 'work order', 'a.b', '_x']) {
      expect(() => ChangedDomain.parse(d)).toThrow();
    }
  });

  it('carries a custom domain through the ToolResult envelope', () => {
    const parsed = ToolResult.parse({
      toolCallId: 'tc_1',
      capability: 'electrical.permit.create',
      ok: true,
      output: {},
      sideEffect: 'write',
      stateChanged: true,
      changedDomains: ['permit', 'conversation'],
      evidence: [],
      metrics: {latencyMs: 1, retries: 0, costUsd: 0, idempotentReplay: false},
      error: null,
    });
    expect(parsed.changedDomains).toEqual(['permit', 'conversation']);
  });
});
