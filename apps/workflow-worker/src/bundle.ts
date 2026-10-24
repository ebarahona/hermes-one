// Builds a self-contained run bundle: compiles the missed-call rule + workflow
// to content-hashed plans and pairs them with tenant parameters + the inbound
// input. In production the plans are pinned in a deployment and loaded by a
// plan-store activity (ADR-014); the bundle keeps the demo one process.
import type {
  CompiledRulePlan,
  CompiledWorkflowPlan,
  DefinitionId,
  IsoTimestamp,
  PinnedRef,
  PlanId,
  RuleDefinition,
  SemVer,
  Principal,
  TraceHeader,
  WorkflowDefinition,
} from '@hermes-one/contracts';
import {builtinRegistry} from '@hermes-one/expression-core';
import {compileRule} from '@hermes-one/rule-dsl';
import {compileWorkflow} from '@hermes-one/workflow-dsl';

const V1 = '1.0.0' as SemVer;
const AT = '2026-07-11T00:00:00.000Z' as IsoTimestamp;

export interface RunBundle {
  workflowPlan: CompiledWorkflowPlan;
  rulePlan: CompiledRulePlan;
  parameters: Record<string, unknown>;
  input: Record<string, unknown>;
}

/** Same shape; the triage workflow adds an agent node routed by the rule. */
export type TriageBundle = RunBundle;

/** A content-addressed plan reference (ADR-014): the load activity resolves it hash-verified. */
export interface PlanLoadRef {
  planId: string;
  contentHash: string;
}

/** The deployment a run is pinned to (D1 — replay determinism for the agent plane). */
export interface DeploymentPin {
  deploymentId: string;
  version: string;
}

/**
 * What a workflow is actually STARTED with (ADR-014): plan refs, not the plans.
 * The workflow loads the compiled plans from the content-addressed store via an activity,
 * scoped by `tenantId` (the cache namespace) and verified by `contentHash`. `deployment`
 * pins the exact deployment version the run belongs to — the agent turn resolves THAT
 * deployment, never whatever is active at turn time (`resolveVersion`).
 * Optional only for workflows with no agent node; `runAgentWorkflow` fails without it.
 */
export interface WorkflowRunRef {
  tenantId: string;
  workflow: PlanLoadRef;
  rule: PlanLoadRef;
  deployment?: DeploymentPin;
  /** The ACTING principal, minted + scope-resolved at the ingest edge (AUTH-2 — never demo literals;
   *  scopes come from RoleRegistry.resolveScopes per request). Required by agent workflows. */
  principal?: Principal;
  /** The conversation this run acts within, minted at the ingest edge alongside the persisted inbound
   *  message (WorkspaceContext.conversationId). Absent for conversation-less
   *  starts; a handoff turn without it persists NO durable task row (handoff_tasks.conversation_id
   *  is NOT NULL), so every conversation-driven start MUST carry it. */
  conversationId?: string;
  parameters: Record<string, unknown>;
  input: Record<string, unknown>;
  /** W3C trace context from the edge (OB5). Carried as an
   *  explicit workflow-input field ("trace on WorkflowExecutionInput") so the turn activity
   *  parents its spans off the edge trace — never ambient across the Temporal boundary. */
  trace?: TraceHeader;
}

/** Derive the start ref from a compiled bundle (after its plans are published). */
export function bundleToRef(
  bundle: RunBundle,
  input: Record<string, unknown>,
  tenantId: string,
  deployment?: DeploymentPin,
  principal?: Principal,
  conversationId?: string,
): WorkflowRunRef {
  return {
    tenantId,
    workflow: {
      planId: bundle.workflowPlan.planId,
      contentHash: bundle.workflowPlan.contentHash,
    },
    rule: {
      planId: bundle.rulePlan.planId,
      contentHash: bundle.rulePlan.contentHash,
    },
    deployment,
    principal,
    conversationId,
    parameters: bundle.parameters,
    input,
  };
}

const missedCallRule: RuleDefinition = {
  definitionId: 'def_missed_call' as DefinitionId,
  kind: 'rule',
  version: V1,
  body: {
    branches: [
      {
        outcome: 'callBack',
        when: {
          type: 'and',
          all: [
            // The run input carries the inbound channel; the demo receives call notices over a
            // voice or an SMS webhook.
            {
              type: 'op',
              op: 'in',
              args: [
                {type: 'fact', path: 'channel'},
                {type: 'literal', value: ['voice', 'sms']},
              ],
            },
            {type: 'not', expr: {type: 'fact', path: 'answered'}},
            {
              type: 'op',
              op: 'in',
              args: [
                {type: 'fact', path: 'zip'},
                {type: 'param', name: 'serviceZips'},
              ],
            },
          ],
        },
      },
      {
        outcome: 'outOfArea',
        when: {
          type: 'not',
          expr: {
            type: 'op',
            op: 'in',
            args: [
              {type: 'fact', path: 'zip'},
              {type: 'param', name: 'serviceZips'},
            ],
          },
        },
      },
    ],
    defaultOutcome: 'ignore',
    parameters: [
      {name: 'serviceZips', type: 'string[]', tenantOverridable: true},
    ],
    requiredFacts: ['channel', 'answered', 'zip'],
  },
};

export function buildBundle(input: Record<string, unknown>): RunBundle {
  const registry = builtinRegistry(V1);
  const rulePlan = compileRule(missedCallRule, {
    registry,
    compilerVersion: V1,
    planId: 'pln_rule' as PlanId,
    compiledAt: AT,
  });
  const ruleRef: PinnedRef = {
    definitionId: rulePlan.definitionId,
    version: rulePlan.version,
    contentHash: rulePlan.contentHash,
  };

  const workflow = {
    definitionId: 'def_missed_call_wf' as DefinitionId,
    kind: 'workflow',
    version: V1,
    body: {
      entry: 'eligibility',
      nodes: {
        eligibility: {
          id: 'eligibility',
          kind: 'rule',
          rule: ruleRef,
          facts: {
            channel: {$input: 'channel'},
            answered: {$input: 'meta.answered'},
            zip: {$input: 'meta.zip'},
          },
          routes: {callBack: 'reply', outOfArea: 'end', default: 'end'},
        },
        reply: {
          id: 'reply',
          kind: 'capability',
          capability: 'messaging.reply.send',
          input: {template: 'missed_call_followup', to: {$input: 'from'}},
          next: 'end',
        },
        end: {id: 'end', kind: 'terminal', outcome: 'completed'},
      },
    },
  };
  const workflowPlan = compileWorkflow(
    workflow as unknown as WorkflowDefinition,
    {
      compilerVersion: V1,
      planId: 'pln_wf' as PlanId,
      compiledAt: AT,
    },
  );

  return {
    workflowPlan,
    rulePlan,
    parameters: {serviceZips: ['75001', '75002']},
    input,
  };
}

// --- triage: rule routes to a bounded agent turn OR a deterministic reply -----

const triageRule: RuleDefinition = {
  definitionId: 'def_triage' as DefinitionId,
  kind: 'rule',
  version: V1,
  body: {
    branches: [
      {
        outcome: 'agentAssist',
        when: {
          type: 'op',
          op: 'equals',
          args: [
            {type: 'fact', path: 'intent'},
            {type: 'literal', value: 'complex'},
          ],
        },
      },
      {
        outcome: 'autoReply',
        when: {
          type: 'op',
          op: 'equals',
          args: [
            {type: 'fact', path: 'intent'},
            {type: 'literal', value: 'simple'},
          ],
        },
      },
    ],
    defaultOutcome: 'ignore',
    parameters: [],
    requiredFacts: ['intent'],
  },
};

export function buildTriageBundle(
  input: Record<string, unknown>,
): TriageBundle {
  const registry = builtinRegistry(V1);
  const rulePlan = compileRule(triageRule, {
    registry,
    compilerVersion: V1,
    planId: 'pln_triage' as PlanId,
    compiledAt: AT,
  });
  const ruleRef: PinnedRef = {
    definitionId: rulePlan.definitionId,
    version: rulePlan.version,
    contentHash: rulePlan.contentHash,
  };

  const workflow = {
    definitionId: 'def_triage_wf' as DefinitionId,
    kind: 'workflow',
    version: V1,
    body: {
      entry: 'triage',
      nodes: {
        triage: {
          id: 'triage',
          kind: 'rule',
          rule: ruleRef,
          facts: {intent: {$input: 'intent'}},
          routes: {agentAssist: 'assist', autoReply: 'reply', default: 'end'},
        },
        assist: {
          id: 'assist',
          kind: 'agent',
          agentEngine: ruleRef,
          objective: 'Help the customer reschedule.',
          next: 'end',
        },
        reply: {
          id: 'reply',
          kind: 'capability',
          capability: 'messaging.reply.send',
          input: {template: 'faq_answer'},
          next: 'end',
        },
        end: {id: 'end', kind: 'terminal', outcome: 'completed'},
      },
    },
  };
  const workflowPlan = compileWorkflow(
    workflow as unknown as WorkflowDefinition,
    {compilerVersion: V1, planId: 'pln_triage_wf' as PlanId, compiledAt: AT},
  );

  return {workflowPlan, rulePlan, parameters: {}, input};
}
