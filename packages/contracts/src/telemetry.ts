// @hermes-one/contracts — src/telemetry.ts
// Observability correlation + structured logging + redaction + the metrics catalogue + trace-propagation
// interfaces. Covers correlation, metrics, logging, redaction, and tracing.
// IMPLEMENTED in @hermes-one/telemetry: the structured Logger + Redactor. Meter + the Temporal
// trace interceptors are transcribed as interfaces only — impl deferred (needs the OTel SDK + Temporal
// interceptors; DEFERRED-AND-FLAGGED OB5).
// NOTE: the contract brands workflowId (WorkflowId) + nodeId (NodeId); WorkflowId has no substrate brand and
// NodeId lives in workflow.ts — typed here as `string | null` to keep this module dependency-light
// (flagged). Logger/Meter interfaces are JIT to the canonical binding keys (platform.telemetry.*).
import {TenantId, WorkspaceId, ConversationId, TurnId} from './substrate.js';

/* --------------------- Correlation (the id bag) ------------------------- */

export interface ObservabilityCorrelationContext {
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId | null;
  readonly conversationId: ConversationId | null;
  readonly workflowId: string | null; // contract: WorkflowId (no substrate brand yet — flagged)
  readonly runId: string | null; // Temporal-assigned, opaque
  readonly nodeId: string | null; // contract: NodeId (workflow.ts) — string here to stay dependency-light
  /** turnId when inside a turn; WorkflowId (as string) before the first turn starts. */
  readonly turnId: TurnId | null;
  /** = turnId at turn scope; = workflowId (string) at workflow scope. Never independently generated. */
  readonly correlationId: string;
  /** Id of the event/decision that produced this one; null for a root cause. */
  readonly causationId: string | null;
  /** OTel — present only where a span was actually opened for this signal. */
  readonly traceId: string | null;
  readonly spanId: string | null;
}

/** Pure derivation — never invents an id, only reads it off the values already in scope. */
export function correlationFromWorkspace(
  ws: {
    workspaceId: WorkspaceId;
    tenantRuntime: {tenantId: TenantId};
    conversationId: ConversationId | null;
    correlationId: string;
  },
  turnId: TurnId | null,
): Pick<
  ObservabilityCorrelationContext,
  'tenantId' | 'workspaceId' | 'conversationId' | 'turnId' | 'correlationId'
> {
  return {
    tenantId: ws.tenantRuntime.tenantId,
    workspaceId: ws.workspaceId,
    conversationId: ws.conversationId,
    turnId,
    correlationId: ws.correlationId,
  };
}

/* ------------------------------- Metrics -------------------------------- */

export const MetricName = {
  TURN_COUNT: 'agent.turn.count', // counter, tags: tenantId, outcome
  TURN_LATENCY_MS: 'agent.turn.latency_ms', // histogram
  TOOL_INVOCATION_COUNT: 'agent.tool.invocation.count', // counter, tags: capability, ok
  TOOL_LATENCY_MS: 'agent.tool.latency_ms', // histogram, tags: capability
  MODEL_LATENCY_MS: 'agent.model.latency_ms', // histogram
  GATE_DECISION_COUNT: 'policy.gate.decision.count', // counter, tags: site, outcome
  WORKFLOW_ACTIVITY_LATENCY_MS: 'temporal.activity.latency_ms', // histogram, tags: activityType
  WORKFLOW_TASK_FAILURE_COUNT: 'temporal.workflow.task_failure.count', // counter
} as const;
export type MetricName = (typeof MetricName)[keyof typeof MetricName];

export interface SloTarget {
  readonly metric: MetricName;
  readonly objective: 'p50' | 'p95' | 'p99' | 'errorRate';
  readonly targetMs?: number; // for latency objectives
  readonly targetRate?: number; // 0..1, for errorRate
  readonly windowDays: number;
}

/** platform.telemetry.meter — JIT interface (impl deferred to the OTel wiring). */
export interface Meter {
  increment(
    metric: MetricName,
    tags?: Record<string, string>,
    by?: number,
  ): void;
  record(
    metric: MetricName,
    value: number,
    tags?: Record<string, string>,
  ): void;
}

/* -------------------------------- Logging -------------------------------- */

export const LogLevel = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LogLevel)[number];

/** The one structured log shape every `platform.telemetry.logger` call emits (JSON, one line). */
export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: string; // IsoTimestamp
  readonly correlation: Partial<ObservabilityCorrelationContext>;
  /** Arbitrary structured fields — subject to redaction before export. */
  readonly fields: Record<string, unknown>;
}

/** platform.telemetry.logger — JIT interface to the canonical binding key. */
export interface Logger {
  log(record: LogRecord): void;
}

/** PII field-classification reused from the retention jobs' PiiCipher dataClass tagging —
 *  NOT a second scheme. A field tagged here with a dataClass gets redacted, never logged raw. */
export type PiiDataClass =
  'direct-identifier' | 'contact-info' | 'financial' | 'health' | 'free-text';

export interface RedactionRule {
  readonly fieldPath: string; // dot path within LogRecord.fields, e.g. "input.phoneNumber"
  readonly dataClass: PiiDataClass;
  readonly strategy: 'mask' | 'hash' | 'drop';
}

/** Bound at `platform.telemetry.redactor`. */
export interface Redactor {
  redact(record: LogRecord): LogRecord;
}

/* -------------------------------- Tracing -------------------------------- */
// Transcribed; impl deferred (Temporal workflow/activity interceptors + OTel SDK — OB5).

/** W3C traceparent, carried explicitly across the Temporal serialization boundary. */
export interface TraceHeader {
  readonly traceparent: string; // "00-<32 hex traceId>-<16 hex spanId>-<2 hex flags>"
  readonly tracestate?: string;
}

export interface WorkflowTraceInterceptor {
  onWorkflowExecute(input: {trace?: TraceHeader}): {childTrace: TraceHeader};
}

export interface ActivityTraceInterceptor {
  onActivityExecute(headers: Record<string, string>): {childTrace: TraceHeader};
}
