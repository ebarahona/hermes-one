import {describe, expect, it} from 'vitest';
import type {TraceHeader} from '@platform/contracts';
import {
  EMPTY_TRACE,
  HeaderActivityTrace,
  PassThroughWorkflowTrace,
  TRACEPARENT_HEADER,
  parentTraceparentFromArg,
  traceToHeaders,
} from './trace-propagation.js';

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('PassThroughWorkflowTrace (spec WorkflowTraceInterceptor)', () => {
  it('yields the inbound trace unchanged (transparent hop, no mutation)', () => {
    const trace: TraceHeader = {traceparent: TP};
    expect(new PassThroughWorkflowTrace().onWorkflowExecute({trace}).childTrace).toEqual(trace);
  });

  it('yields the empty trace when no inbound trace is present', () => {
    expect(new PassThroughWorkflowTrace().onWorkflowExecute({}).childTrace).toEqual(EMPTY_TRACE);
  });
});

describe('HeaderActivityTrace (spec ActivityTraceInterceptor)', () => {
  it('extracts exactly the traceparent that was injected (no mutation)', () => {
    const headers = {[TRACEPARENT_HEADER]: TP};
    expect(new HeaderActivityTrace().onActivityExecute(headers).childTrace.traceparent).toBe(TP);
  });

  it('yields an empty traceparent when the header is absent', () => {
    expect(new HeaderActivityTrace().onActivityExecute({}).childTrace.traceparent).toBe('');
  });
});

describe('sidecar <-> header round-trip', () => {
  it('projects a present trace into headers and back to the same parent traceparent', () => {
    expect(traceToHeaders({traceparent: TP})).toEqual({[TRACEPARENT_HEADER]: TP});
    expect(parentTraceparentFromArg({traceparent: TP})).toBe(TP);
  });

  it('drops a blank/absent trace to no headers and no parent', () => {
    expect(traceToHeaders(undefined)).toEqual({});
    expect(traceToHeaders({traceparent: ''})).toEqual({});
    expect(parentTraceparentFromArg(undefined)).toBeUndefined();
    expect(parentTraceparentFromArg({traceparent: ''})).toBeUndefined();
  });
});
