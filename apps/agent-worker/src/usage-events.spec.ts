import {describe, expect, it} from 'vitest';
import type {IsoTimestamp, PrincipalId, TenantId, TurnId} from '@platform/contracts';
import type {TurnLedger} from '@platform-internal/agent-runtime';
import {deriveUsageEvents} from './usage-events.js';

const NOW = '2026-07-13T09:00:00.000Z' as IsoTimestamp;

const ledger: TurnLedger = {
  turnId: 'trn_u' as TurnId,
  tenantId: 'tnt_u' as TenantId,
  correlationId: 'trn_u',
  toolExecutions: [],
  evidence: [],
  policyDecisions: [],
  usage: {modelCostUsd: 0.0021, inputTokens: 1200, outputTokens: 340, toolCount: 2},
};
const ctx = {principalId: 'prn_u' as PrincipalId, occurredAt: NOW};

describe('deriveUsageEvents', () => {
  it('meters model tokens/cost + tool-invocation count with correct kinds/units/quantities', () => {
    const events = deriveUsageEvents(ledger, ctx);
    expect(events.map(e => [e.meterKind, e.quantity, e.unit])).toEqual([
      ['model.input.tokens', 1200, 'tokens'],
      ['model.output.tokens', 340, 'tokens'],
      ['model.cost.usd', 0.0021, 'usd'],
      ['tool.invocation', 2, 'count'],
    ]);
    for (const e of events) {
      expect(e.id).toMatch(/^usg_[0-9a-f]{24}$/);
      expect(e.correlationId).toBe('trn_u');
      expect(e.turnId).toBe('trn_u');
      expect(e.capability).toBeNull();
    }
  });

  it('derives a stable dedupeKey per (turn, meterKind) — exactly-once billing under replay', () => {
    const a = deriveUsageEvents(ledger, ctx);
    const b = deriveUsageEvents(ledger, ctx);
    expect(a.map(e => e.dedupeKey)).toEqual(b.map(e => e.dedupeKey));
    // dedupeKey = principalId:correlationId:meterKind:sequence
    expect(a[0].dedupeKey).toBe('prn_u:trn_u:model.input.tokens:0');
    // all distinct across kinds
    expect(new Set(a.map(e => e.dedupeKey)).size).toBe(4);
  });
});
