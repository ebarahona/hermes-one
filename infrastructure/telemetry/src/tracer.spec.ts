import {describe, expect, it} from 'vitest';
import {createInMemoryTracing, NoopTracer, traceHeaderFrom} from './tracer.js';

/** W3C traceparent: "00-<32 hex traceId>-<16 hex spanId>-<2 hex flags>". */
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const traceIdOf = (tp: string) => tp.split('-')[1];
const spanIdOf = (tp: string) => tp.split('-')[2];

describe('OtelTracer (explicit traceparent propagation)', () => {
  it('emits a well-formed traceparent whose traceId matches the span', async () => {
    const {tracer, exporter, shutdown} = createInMemoryTracing();
    const s = tracer.startSpan('edge.request', {attributes: {'tenant.id': 'tnt_1'}});
    expect(s.traceparent).toMatch(TRACEPARENT_RE);
    expect(traceIdOf(s.traceparent)).toBe(s.traceId);
    s.end();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('edge.request');
    expect(spans[0].attributes['tenant.id']).toBe('tnt_1');
    await shutdown();
  });

  it('a child parented by the parent traceparent shares the traceId and points at the parent span', async () => {
    const {tracer, exporter, shutdown} = createInMemoryTracing();
    const parent = tracer.startSpan('temporal.activity.agentTurn');
    // Simulate the next hop: only the traceparent string crosses the boundary.
    const child = tracer.startSpan('agent.turn', {parentTraceparent: parent.traceparent});
    const tool = tracer.startSpan('agent.tool.messaging.reply.send', {parentTraceparent: child.traceparent});
    tool.end();
    child.end();
    parent.end();

    // #1 acceptance test: a span exported at agent.tool.* has the same traceId as the edge/activity span.
    expect(child.traceId).toBe(parent.traceId);
    expect(tool.traceId).toBe(parent.traceId);

    const byName = new Map(exporter.getFinishedSpans().map(s => [s.name, s]));
    expect(byName.get('agent.turn')!.parentSpanContext?.spanId).toBe(spanIdOf(parent.traceparent));
    expect(byName.get('agent.tool.messaging.reply.send')!.parentSpanContext?.spanId).toBe(spanIdOf(child.traceparent));
    await shutdown();
  });

  it('records error status on ok:false', async () => {
    const {tracer, exporter, shutdown} = createInMemoryTracing();
    const s = tracer.startSpan('agent.tool.x');
    s.end({ok: false, error: new Error('vendor rejected')});
    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(2 /* SpanStatusCode.ERROR */);
    expect(span.events.some(e => e.name === 'exception')).toBe(true);
    await shutdown();
  });

  it('an absent parent traceparent starts a fresh root trace', async () => {
    const {tracer, shutdown} = createInMemoryTracing();
    const a = tracer.startSpan('edge.request');
    const b = tracer.startSpan('edge.request'); // no parent → different trace
    expect(a.traceId).not.toBe(b.traceId);
    a.end();
    b.end();
    await shutdown();
  });
});

describe('NoopTracer', () => {
  it('produces an empty, inert scope when tracing is disabled', () => {
    const s = new NoopTracer().startSpan('edge.request');
    expect(s.traceparent).toBe('');
    expect(s.traceId).toBe('');
    expect(() => {
      s.setAttributes({a: '1'});
      s.end({ok: false, error: new Error('x')});
    }).not.toThrow();
  });
});

describe('traceHeaderFrom', () => {
  it('wraps a present traceparent and nulls a blank one', () => {
    expect(traceHeaderFrom('00-abc-def-01')).toEqual({traceparent: '00-abc-def-01'});
    expect(traceHeaderFrom('')).toBeNull();
    expect(traceHeaderFrom(undefined)).toBeNull();
    expect(traceHeaderFrom(null)).toBeNull();
  });
});
