// Distributed-tracing impl (OB5). The platform's spans cross
// three hops OTel does not bridge automatically — edge (LB4) → Temporal (workflow/activity) → agentback
// (turn/tool) — so propagation is EXPLICIT: every span exposes its own W3C `traceparent`, and a child
// span is parented by passing that string, never by relying on ambient async-hooks context (which does
// not survive a Temporal serialization boundary / the deterministic sandbox).
//
// JIT (flagged): the contract names the binding `platform.telemetry.tracer: Tracer` but gives no TS method
// shape for `Tracer` (only the trace-header + interceptor interfaces). This `Tracer`/`SpanScope` port is
// authored JIT to the canonical binding key + the span tree (names/attributes), the same
// way `Logger`/`Meter` were. The `traceparent`-only parenting model is the faithful realization of the
// doc's "explicit-header, never ambient" propagation contract.
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  defaultTextMapGetter,
  defaultTextMapSetter,
  trace,
  type Span,
  type Tracer as OtelApiTracer,
} from '@opentelemetry/api';
import {W3CTraceContextPropagator} from '@opentelemetry/core';
import {resourceFromAttributes} from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {NodeTracerProvider} from '@opentelemetry/sdk-trace-node';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {ATTR_SERVICE_NAME} from '@opentelemetry/semantic-conventions';
import type {TraceHeader} from '@platform/contracts';

/** Span attribute values the platform sets (strings, booleans). */
export type SpanAttributes = Record<string, string | number | boolean>;

/** A started span. `traceparent` is THIS span's W3C header — inject it into the next hop to make its
 *  spans children of this one. Ending is idempotent; `ok:false`/`error` records the error status. */
export interface SpanScope {
  readonly traceparent: string;
  readonly traceId: string;
  setAttributes(attrs: SpanAttributes): void;
  end(opts?: {ok?: boolean; error?: Error}): void;
}

/** platform.telemetry.tracer — the explicit-propagation tracer port (JIT to the binding key). */
export interface Tracer {
  /** Start a span. `parentTraceparent` (if a valid W3C header) makes this a child of that span's trace;
   *  absent/invalid → a new root trace. Attributes are set at start. */
  startSpan(name: string, opts?: {parentTraceparent?: string; attributes?: SpanAttributes}): SpanScope;
}

const propagator = new W3CTraceContextPropagator();

/** Build the W3C `traceparent` for a span (what downstream hops extract). Empty string if not recorded. */
function traceparentOf(span: Span, parentContext = ROOT_CONTEXT): string {
  const carrier: Record<string, string> = {};
  propagator.inject(trace.setSpan(parentContext, span), carrier, defaultTextMapSetter);
  return carrier.traceparent ?? '';
}

class OtelSpanScope implements SpanScope {
  constructor(
    private readonly span: Span,
    readonly traceparent: string,
    readonly traceId: string,
  ) {}

  setAttributes(attrs: SpanAttributes): void {
    this.span.setAttributes(attrs);
  }

  end(opts?: {ok?: boolean; error?: Error}): void {
    if (opts?.error) this.span.recordException(opts.error);
    if (opts && opts.ok === false) {
      this.span.setStatus({code: SpanStatusCode.ERROR, message: opts.error?.message});
    }
    this.span.end();
  }
}

/** Tracer backed by an OTel `TracerProvider`. Parenting is driven only by the passed `traceparent`. */
export class OtelTracer implements Tracer {
  constructor(private readonly otel: OtelApiTracer) {}

  startSpan(name: string, opts?: {parentTraceparent?: string; attributes?: SpanAttributes}): SpanScope {
    const parentContext =
      opts?.parentTraceparent && opts.parentTraceparent.length > 0
        ? propagator.extract(ROOT_CONTEXT, {traceparent: opts.parentTraceparent}, defaultTextMapGetter)
        : ROOT_CONTEXT;
    const span = this.otel.startSpan(name, {attributes: opts?.attributes}, parentContext);
    return new OtelSpanScope(span, traceparentOf(span, parentContext), span.spanContext().traceId);
  }
}

/** No-op tracer for when tracing is disabled — every span is a valid, empty scope (traceparent ''). */
export class NoopTracer implements Tracer {
  startSpan(_name?: string, _opts?: {parentTraceparent?: string; attributes?: SpanAttributes}): SpanScope {
    return {
      traceparent: '',
      traceId: '',
      setAttributes() {},
      end() {},
    };
  }
}

/* ------------------------------ Provider bootstrap ------------------------------ */

export interface TracingConfig {
  /** Off → NoopTracer (unit tests, or a deployment with tracing disabled). */
  readonly enabled: boolean;
  /** resource `service.name` — the worker/app identity in the trace backend. */
  readonly serviceName: string;
  /** otlp → ship to a collector (prod); console → stdout (dev); none → provider with no exporter. */
  readonly exporter: 'otlp' | 'console' | 'none';
  /** OTLP/HTTP traces endpoint, e.g. http://127.0.0.1:4318/v1/traces (used when exporter==='otlp'). */
  readonly otlpEndpoint?: string;
}

export interface TracingHandle {
  readonly tracer: Tracer;
  /** Flush + shut the provider down (call on worker stop so batched spans are not lost). */
  shutdown(): Promise<void>;
}

function exporterFor(cfg: TracingConfig): {exporter: SpanExporter; batch: boolean} | null {
  switch (cfg.exporter) {
    case 'otlp':
      return {exporter: new OTLPTraceExporter({url: cfg.otlpEndpoint}), batch: true};
    case 'console':
      return {exporter: new ConsoleSpanExporter(), batch: false};
    case 'none':
      return null;
  }
}

/**
 * Build the tracing handle from config. Disabled → NoopTracer. Enabled → a `NodeTracerProvider` with the
 * chosen exporter; the provider is NOT registered globally (no global mutable state — the platform passes
 * the `tracer` explicitly, and parent/child is carried by `traceparent`, so no ambient ContextManager is
 * needed). Own the shutdown so batched spans flush on worker stop.
 */
export function initTracing(cfg: TracingConfig): TracingHandle {
  if (!cfg.enabled) return {tracer: new NoopTracer(), shutdown: async () => {}};

  const chosen = exporterFor(cfg);
  const processors: SpanProcessor[] = chosen
    ? [chosen.batch ? new BatchSpanProcessor(chosen.exporter) : new SimpleSpanProcessor(chosen.exporter)]
    : [];
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({[ATTR_SERVICE_NAME]: cfg.serviceName}),
    spanProcessors: processors,
  });
  return {
    tracer: new OtelTracer(provider.getTracer('hermes')),
    shutdown: () => provider.shutdown(),
  };
}

/** Map the platform `otel` config block + a per-app service name onto a `TracingConfig`. */
export function tracingConfigFor(
  otel: {mode: 'off' | 'console' | 'otlp'; endpoint: string},
  serviceName: string,
): TracingConfig {
  return {
    enabled: otel.mode !== 'off',
    serviceName,
    exporter: otel.mode === 'off' ? 'none' : otel.mode,
    otlpEndpoint: otel.endpoint,
  };
}

/**
 * In-memory tracing for tests: a `SimpleSpanProcessor` (synchronous export on `end()`) over an
 * `InMemorySpanExporter`, so a test can assert the exported span tree without a collector.
 */
export function createInMemoryTracing(serviceName = 'test'): {
  tracer: Tracer;
  exporter: InMemorySpanExporter;
  shutdown(): Promise<void>;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({[ATTR_SERVICE_NAME]: serviceName}),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return {tracer: new OtelTracer(provider.getTracer('hermes')), exporter, shutdown: () => provider.shutdown()};
}

/* ------------------------------ W3C traceparent helpers ------------------------------ */

/** Read the incoming `traceparent` string as the platform's `TraceHeader` (null if absent/blank). */
export function traceHeaderFrom(traceparent: string | undefined | null): TraceHeader | null {
  if (!traceparent || traceparent.length === 0) return null;
  return {traceparent};
}
