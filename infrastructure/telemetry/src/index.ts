// @platform-internal/telemetry — infrastructure (none plane).
// Structured logging + PII redaction + metrics catalogue + OTel distributed tracing
// (observability/tracing-metrics-logging.md). `initTracing`/`OtelTracer` export real spans over an
// OTLP/Console exporter; the Temporal trace interceptors live in @platform-internal/temporal-client. The
// OTel-backed Meter (histogram aggregation) remains the prod swap — see docs/DEFERRED-AND-FLAGGED.md (OB5).
export {JsonLogger, RedactingLogger} from './logger.js';
export {FieldRedactor} from './redactor.js';
export {InMemoryMeter, LoggingMeter, DEFAULT_SLO_TARGETS, type MeterSnapshot} from './meter.js';
export {
  OtelTracer,
  NoopTracer,
  initTracing,
  tracingConfigFor,
  createInMemoryTracing,
  traceHeaderFrom,
  type Tracer,
  type SpanScope,
  type SpanAttributes,
  type TracingConfig,
  type TracingHandle,
} from './tracer.js';

export const descriptor = {
  name: '@platform-internal/telemetry',
  role: 'infrastructure',
  plane: 'none',
  published: false,
  sourceDocs: ['observability/tracing-metrics-logging', 'observability/observability-architecture'],
  governedBy: ['ADR-009'],
} as const;
