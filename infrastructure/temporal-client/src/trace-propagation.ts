// Temporal-boundary trace propagation (OB5). Temporal does not
// carry OTel context across the client→workflow or workflow→activity boundary — both are serialization
// boundaries and workflow code runs in a deterministic sandbox where ambient async-hooks context does not
// survive. Propagation is therefore EXPLICIT: the W3C `traceparent` is carried as a literal field across
// each hop and extracted by the contract-shaped seams below (`WorkflowTraceInterceptor` /
// `ActivityTraceInterceptor`), never assumed to survive via AsyncLocalStorage.
//
// MECHANISM (flagged — the interceptor-package choice is left to this infra build; the
// header-injection contract is stable either way): rather than Temporal's internal header
// dictionary + a sandbox payload converter, the traceparent rides as an explicit field on the boundary
// values that already cross — `WorkflowRunRef.trace` (client→workflow, "trace on
// WorkflowExecutionInput") and an explicit sidecar arg to the turn activity (workflow→activity,
// "ActivityOptions.headers"). The extraction seams keep the exact header-based contract shape.
// RESIDUAL (OB5): the intermediate `temporal.workflow.*` SPAN body is not emitted from inside the sandbox
// (needs a Temporal span sink, e.g. @temporalio/interceptors-opentelemetry) — the workflow hop is a
// transparent propagation for now, so trace CONTINUITY (edge → activity → turn → tool share one traceId)
// holds while the workflow-scope span is deferred.
import type {
  ActivityTraceInterceptor,
  TraceHeader,
  WorkflowTraceInterceptor,
} from '@platform/contracts';

/** The W3C header name the traceparent is carried under */
export const TRACEPARENT_HEADER = 'traceparent';

/** A trace header carrying no context — downstream treats it as "start a fresh root". */
export const EMPTY_TRACE: TraceHeader = {traceparent: ''};

/**
 * Workflow-scope trace seam (`WorkflowTraceInterceptor`). Extracts the inbound trace so the workflow
 * can inject it into the activities it schedules. The workflow-scope span body is deferred (see RESIDUAL
 * above), so this is a transparent hop: `childTrace` is the inbound trace unchanged, preserving continuity.
 */
export class PassThroughWorkflowTrace implements WorkflowTraceInterceptor {
  onWorkflowExecute(input: {trace?: TraceHeader}): {childTrace: TraceHeader} {
    return {childTrace: input.trace ?? EMPTY_TRACE};
  }
}

/**
 * Activity-scope trace seam (`ActivityTraceInterceptor`). Reads the `traceparent` header the workflow
 * injected so the activity can parent its `temporal.activity.*` / `agent.turn` span off it.
 */
export class HeaderActivityTrace implements ActivityTraceInterceptor {
  onActivityExecute(headers: Record<string, string>): {
    childTrace: TraceHeader;
  } {
    return {childTrace: {traceparent: headers[TRACEPARENT_HEADER] ?? ''}};
  }
}

/** Project a `TraceHeader` (carried as an explicit activity arg) into the header dict the seam reads. */
export function traceToHeaders(
  trace: TraceHeader | undefined,
): Record<string, string> {
  return trace && trace.traceparent.length > 0
    ? {[TRACEPARENT_HEADER]: trace.traceparent}
    : {};
}

/** The extracted parent traceparent (or undefined) an activity should parent its span off. */
export function parentTraceparentFromArg(
  trace: TraceHeader | undefined,
): string | undefined {
  const {childTrace} = new HeaderActivityTrace().onActivityExecute(
    traceToHeaders(trace),
  );
  return childTrace.traceparent.length > 0 ? childTrace.traceparent : undefined;
}
