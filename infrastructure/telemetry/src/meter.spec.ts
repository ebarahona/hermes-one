import {describe, expect, it} from 'vitest';
import {MetricName, type LogRecord} from '@hermes-one/contracts';
import {InMemoryMeter, LoggingMeter, DEFAULT_SLO_TARGETS} from './meter.js';

describe('InMemoryMeter', () => {
  it('accumulates counters and histogram samples, keyed by metric + sorted tags', () => {
    const m = new InMemoryMeter();
    m.increment(MetricName.TURN_COUNT, {outcome: 'replied', tenantId: 'tnt'});
    m.increment(MetricName.TURN_COUNT, {tenantId: 'tnt', outcome: 'replied'}); // same series (tag order agnostic)
    m.increment(MetricName.TURN_COUNT, {outcome: 'handoff', tenantId: 'tnt'});
    m.record(MetricName.TURN_LATENCY_MS, 120, {tenantId: 'tnt'});
    m.record(MetricName.TURN_LATENCY_MS, 80, {tenantId: 'tnt'});

    const s = m.snapshot();
    expect(s.counters['agent.turn.count{outcome=replied,tenantId=tnt}']).toBe(
      2,
    );
    expect(s.counters['agent.turn.count{outcome=handoff,tenantId=tnt}']).toBe(
      1,
    );
    expect(s.histograms['agent.turn.latency_ms{tenantId=tnt}']).toEqual([
      120, 80,
    ]);
  });
});

describe('LoggingMeter', () => {
  it('emits a structured log record per metric event', () => {
    const records: LogRecord[] = [];
    const logger = {log: (r: LogRecord) => records.push(r)};
    const m = new LoggingMeter(
      logger,
      () => new Date('2026-07-13T00:00:00.000Z'),
    );
    m.increment(MetricName.TOOL_INVOCATION_COUNT, {
      capability: 'appointment.slot.read',
      ok: 'true',
    });
    m.record(MetricName.TOOL_LATENCY_MS, 12, {
      capability: 'appointment.slot.read',
    });

    expect(records[0]).toMatchObject({
      message: 'metric.counter',
      fields: {metric: 'agent.tool.invocation.count', by: 1},
    });
    expect(records[1]).toMatchObject({
      message: 'metric.histogram',
      fields: {metric: 'agent.tool.latency_ms', value: 12},
    });
  });
});

describe('DEFAULT_SLO_TARGETS', () => {
  it('is the transcribed catalogue (turn p95, tool p99, task-failure errorRate)', () => {
    expect(DEFAULT_SLO_TARGETS).toContainEqual({
      metric: 'agent.turn.latency_ms',
      objective: 'p95',
      targetMs: 8000,
      windowDays: 7,
    });
    expect(
      DEFAULT_SLO_TARGETS.find(s => s.objective === 'errorRate')?.targetRate,
    ).toBe(0.005);
  });
});
