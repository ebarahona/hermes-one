import {describe, expect, it} from 'vitest';
import type {TurnLedger} from '@platform-internal/agent-runtime';
import {InMemoryMeter} from '@platform-internal/telemetry';
import {emitTurnMetrics} from './turn-metrics.js';

const ledger = (): TurnLedger => ({
  turnId: 'trn' as TurnLedger['turnId'],
  tenantId: 'tnt' as TurnLedger['tenantId'],
  correlationId: 'trn',
  toolExecutions: [
    {
      call: {} as never,
      result: {
        capability: 'appointment.slot.read',
        ok: true,
        metrics: {latencyMs: 12},
      } as never,
    },
  ],
  evidence: [],
  policyDecisions: [
    {decisionId: 'p1', site: 'preGate', decision: {outcome: 'allow'} as never},
    {decisionId: 'p2', site: 'postGate', decision: {outcome: 'allow'} as never},
  ],
  usage: {modelCostUsd: 0, inputTokens: 0, outputTokens: 0, toolCount: 1},
});

describe('emitTurnMetrics', () => {
  it('derives turn/tool/gate metrics from the ledger + wall latency', () => {
    const m = new InMemoryMeter();
    emitTurnMetrics(m, ledger(), 'replied', 250);
    const s = m.snapshot();

    expect(s.counters['agent.turn.count{outcome=replied,tenantId=tnt}']).toBe(
      1,
    );
    expect(
      s.counters[
        'agent.tool.invocation.count{capability=appointment.slot.read,ok=true}'
      ],
    ).toBe(1);
    expect(
      s.counters['policy.gate.decision.count{outcome=allow,site=preGate}'],
    ).toBe(1);
    expect(
      s.counters['policy.gate.decision.count{outcome=allow,site=postGate}'],
    ).toBe(1);
    expect(s.histograms['agent.turn.latency_ms{tenantId=tnt}']).toEqual([250]);
    expect(
      s.histograms['agent.tool.latency_ms{capability=appointment.slot.read}'],
    ).toEqual([12]);
  });
});
