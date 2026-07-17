// The Temporal workflows (ADR-014): they register `executeCompiledWorkflow` and
// delegate every side effect to activities via proxyActivities — edge effects to
// activity-worker (ACTIVITY_QUEUE), the agent turn to agent-worker (AGENT_QUEUE).
// This module is bundled into Temporal's deterministic sandbox, so it imports the
// interpreter from the `/interpreter` subpath (type-only contracts → no zod/crypto)
// and declares the activity interfaces inline (Temporal binds them by name at
// runtime — no cross-app import). `bundle` is a type-only import (erased).
import {proxyActivities, workflowInfo} from '@temporalio/workflow';
import {
  executeCompiledWorkflow,
  type WorkflowEffects,
} from '@platform/workflow-dsl/interpreter';
import type {
  CompiledRulePlan,
  CompiledWorkflowPlan,
  IsoTimestamp,
  PinnedRef,
  RuleFacts,
  TraceHeader,
  TurnRequest,
  TurnResult,
} from '@platform/contracts';
import {
  PassThroughWorkflowTrace,
  RETRY_POLICY_REGISTRY,
  retryPolicyClassForCapability,
  toTemporalActivityOptions,
} from '@platform-internal/temporal-client';
import type {WorkflowRunRef} from './bundle.js';
import {buildAgentTurnRequest} from './turn-request.js';
import {ACTIVITY_QUEUE, AGENT_QUEUE} from './queues.js';

/** Edge activities (activity-worker) — bound by name at runtime. */
interface EdgeActivities {
  loadWorkflowPlan(a: {tenantId: string; planId: string; contentHash: string}): Promise<CompiledWorkflowPlan>;
  loadRulePlan(a: {tenantId: string; planId: string; contentHash: string}): Promise<CompiledRulePlan>;
  evaluateRule(a: {
    rulePlan: CompiledRulePlan;
    parameters: Record<string, unknown>;
    facts: RuleFacts;
    now: IsoTimestamp;
  }): Promise<{outcome: string; emit?: Record<string, unknown>}>;
  invokeCapability(a: {
    capability: string;
    input: Record<string, unknown>;
    tenantId: string;
    correlationId: string;
  }): Promise<{delivered: boolean; capability: string; ok: boolean; providerMessageId?: string}>;
  emitDecisionRule(a: {
    tenantId: string;
    correlationId: string;
    outcome: string;
    rulePlanId: string;
    occurredAt: string;
  }): Promise<void>;
}

/** Agent activity (agent-worker) — the bounded turn, on its own plane/queue. Serializable TurnRequest→TurnResult.
 *  `trace` carries the W3C traceparent to parent the turn/tool spans off the edge trace (OB5). */
interface AgentActivities {
  agentTurn(a: TurnRequest, trace?: TraceHeader): Promise<TurnResult>;
}

// Retry classes per temporal/retry-policy-registry.md — every activity resolves to exactly one of
// the six canonical profiles; no ad-hoc per-activity retry tuning:
// - plan loads / rule evaluation / audit emission are `internal-db` (state-loading / audit-persistence);
// - the capability node's send is capability-execution resolved by the capability's SideEffectClass —
//   the ONE capability routed here today (messaging.reply.send) is sideEffect:'external' →
//   `non-idempotent-guarded-write`, maximumAttempts:1: Temporal never auto-retries a vendor send;
//   the workflow decides any redo with a fresh idempotencyKey. Per-capability dynamic class dispatch
//   (multiple capabilities with differing side effects) needs the sideEffect in the compiled plan — flagged;
// - the agent turn is `model-call` (attempt-once, 120s + 20s heartbeat — 059 §9).
const {loadWorkflowPlan, loadRulePlan, evaluateRule, emitDecisionRule} =
  proxyActivities<EdgeActivities>({
    taskQueue: ACTIVITY_QUEUE,
    ...toTemporalActivityOptions(RETRY_POLICY_REGISTRY['internal-db']),
  });
const {invokeCapability} = proxyActivities<EdgeActivities>({
  taskQueue: ACTIVITY_QUEUE,
  ...toTemporalActivityOptions(RETRY_POLICY_REGISTRY[retryPolicyClassForCapability('external')]),
});
const {agentTurn} = proxyActivities<AgentActivities>({
  taskQueue: AGENT_QUEUE,
  ...toTemporalActivityOptions(RETRY_POLICY_REGISTRY['model-call']),
});

/** Pure fact-gathering runs in the workflow (deterministic, no I/O). */
function gatherFacts(
  spec: Record<string, unknown>,
  input: Record<string, unknown>,
): RuleFacts {
  const facts: RuleFacts = {};
  for (const [k, v] of Object.entries(spec)) {
    facts[k] =
      v && typeof v === 'object' && '$input' in v
        ? input[(v as {$input: string}).$input]
        : v;
  }
  return facts;
}

function edgeEffects(
  rulePlan: CompiledRulePlan,
  parameters: Record<string, unknown>,
  tenantId: string,
  correlationId: string,
): WorkflowEffects {
  return {
    gatherFacts,
    // Evaluate the rule, then emit a `decision.rule` audit event — the deterministic-rail signal behind
    // the deterministic-hit-rate KPI. One decision per inbound; idempotent on replay.
    evaluateRule: async (_ref: PinnedRef, facts, now) => {
      const result = await evaluateRule({rulePlan, parameters, facts, now});
      await emitDecisionRule({tenantId, correlationId, outcome: result.outcome, rulePlanId: rulePlan.planId, occurredAt: now});
      return result;
    },
    invokeCapability: (capability, input) =>
      invokeCapability({capability, input, tenantId, correlationId}),
    now: () => new Date().toISOString() as IsoTimestamp,
  };
}

/** No-LLM missed-call workflow: load plans (activity) → rule → reply → terminal. */
export async function runMissedCall(ref: WorkflowRunRef) {
  const workflowPlan = await loadWorkflowPlan({tenantId: ref.tenantId, ...ref.workflow});
  const rulePlan = await loadRulePlan({tenantId: ref.tenantId, ...ref.rule});
  return executeCompiledWorkflow(
    workflowPlan,
    {input: ref.input},
    edgeEffects(rulePlan, ref.parameters, ref.tenantId, workflowInfo().workflowId),
  );
}

/** Triage workflow: rule routes to a bounded agent turn OR a deterministic reply. */
export async function runTriage(ref: WorkflowRunRef) {
  // The agent plane replays against the deployment PINNED at start (D1), acting AS the principal
  // minted at the edge (AUTH-2) — an agent workflow started without either is a configuration error,
  // failed before any side effect runs.
  const pin = ref.deployment;
  if (!pin) throw new Error('runTriage requires ref.deployment — the agent turn resolves the PINNED deployment (D1)');
  const principal = ref.principal;
  if (!principal) throw new Error('runTriage requires ref.principal — the acting identity is minted at the edge (AUTH-2)');
  const workflowPlan = await loadWorkflowPlan({tenantId: ref.tenantId, ...ref.workflow});
  const rulePlan = await loadRulePlan({tenantId: ref.tenantId, ...ref.rule});
  const correlationId = workflowInfo().workflowId;
  const effects: WorkflowEffects = {
    ...edgeEffects(rulePlan, ref.parameters, ref.tenantId, correlationId),
    // the agent turn crosses to agent-worker (agent plane) as its own activity, carrying a serializable
    // TurnRequest and returning a TurnResult (ADR-017); the workflow maps it to the interpreter's shape.
    runAgentTurn: async (engine, objective, input) => {
      // Trace propagation (OB5): extract the child trace via the WorkflowTraceInterceptor seam and carry
      // it as an explicit sidecar arg to the turn activity (the spec's "traceparent on ActivityOptions").
      const {childTrace} = new PassThroughWorkflowTrace().onWorkflowExecute({trace: ref.trace});
      const result = await agentTurn(
        // startedAt = WORKFLOW time (Temporal's sandbox Date is deterministic on replay/reset), so a
        // re-execution with identical args re-derives byte-identical durable rows (audit tamper-reject
        // safe). The activity's wall clock stays for operational concerns only.
        buildAgentTurnRequest(
          ref.tenantId, pin, principal, engine, objective, input, correlationId,
          new Date().toISOString(),
        ),
        childTrace,
      );
      return {outcome: result.outcome, reply: result.reply};
    },
  };
  return executeCompiledWorkflow(workflowPlan, {input: ref.input}, effects);
}
