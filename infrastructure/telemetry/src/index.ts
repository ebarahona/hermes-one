// @platform-internal/telemetry — infrastructure (none plane).
// Structured logging + PII redaction primitives (observability/tracing-metrics-logging.md). The Temporal
// trace interceptors + the OTel Meter impl are deferred (need the OTel SDK) — see docs/DEFERRED-AND-FLAGGED.md.
export {JsonLogger, RedactingLogger} from './logger.js';
export {FieldRedactor} from './redactor.js';
export {InMemoryMeter, LoggingMeter, DEFAULT_SLO_TARGETS, type MeterSnapshot} from './meter.js';

export const descriptor = {
  name: '@platform-internal/telemetry',
  role: 'infrastructure',
  plane: 'none',
  published: false,
  sourceDocs: ['observability/tracing-metrics-logging', 'observability/observability-architecture'],
  governedBy: ['ADR-009'],
} as const;
