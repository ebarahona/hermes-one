// Full-stack integration — the platform thesis in one flow: THE WORKFLOW OWNS
// ROUTING; a deterministic `rule` node decides, and either a `capability` node
// answers deterministically OR an `agent` node runs a BOUNDED turn. The agent
// turn is the real single-step loop + tool-executor dispatching a real agentback
// tool. The `runAgentTurn` effect is the serializable seam Temporal would cross
// into agent-worker — here it runs in-process so the whole stack is verifiable.
//
// Exercises: workflow-dsl + rule-dsl + expression-core + agentback-runtime +
// tool-executor + agent-runtime, together.
import {describe, it, expect} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {
  MCPBindings,
  MCP_DISPATCH_HOOK_TAG,
  type MCPServer,
} from '@agentback/mcp';
import type {Context} from '@agentback/context';
import type {
  CapabilityName,
  DefinitionId,
  IsoTimestamp,
  PinnedRef,
  PlanId,
  RuleDefinition,
  RuleFacts,
  SemVer,
  ToolCall,
  WorkflowDefinition,
} from '@hermes-one/contracts';
import {builtinRegistry} from '@hermes-one/expression-core';
import {compileRule, createRuleRuntime} from '@hermes-one/rule-dsl';
import {
  compileWorkflow,
  executeCompiledWorkflow,
  type WorkflowEffects,
} from '@hermes-one/workflow-dsl';
import {createAgentPlaneApp} from '@hermes-one/agentback-runtime';
import {
  PlatformToolExecutor,
  createEnvelopeHook,
  type CapabilityMeta,
  type CapabilityMetaSource,
} from '@hermes-one/tool-executor';
import {runTurn, type Decider} from './index.js';
import {testTurnRequest, noUsage} from './_test-fixtures.js';

const V1 = '1.0.0' as SemVer;
const NOW = '2026-07-11T15:04:00.000Z' as IsoTimestamp;

// --- deterministic triage rule: route by intent ------------------------------
const registry = builtinRegistry(V1);
const ruleRuntime = createRuleRuntime(registry);
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
const rulePlan = compileRule(triageRule, {
  registry,
  compilerVersion: V1,
  planId: 'pln_triage' as PlanId,
  compiledAt: NOW,
});
const ruleRef: PinnedRef = {
  definitionId: rulePlan.definitionId,
  version: rulePlan.version,
  contentHash: rulePlan.contentHash,
};

// --- the workflow: rule → {agent | capability | end} -------------------------
const triageWorkflow = {
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
        agentEngine: ruleRef, // any PinnedRef; the engine is resolved by the turn
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
const wfPlan = compileWorkflow(
  triageWorkflow as unknown as WorkflowDefinition,
  {
    compilerVersion: V1,
    planId: 'pln_triage_wf' as PlanId,
    compiledAt: NOW,
  },
);

const CAP_META: Record<string, CapabilityMeta> = {
  'appointment.slot.read': {sideEffect: 'read', changedDomains: ['none']},
};
const metaSource: CapabilityMetaSource = n =>
  CAP_META[n] ?? {sideEffect: 'read', changedDomains: ['none']};

function boot() {
  const app = createAgentPlaneApp({fixtures: true});
  app
    .bind('platform.hook.envelope')
    .to(createEnvelopeHook())
    .tag(MCP_DISPATCH_HOOK_TAG);
  return app;
}

describe('full-stack: workflow routes deterministic rule OR bounded agent turn', () => {
  it('a complex intent routes to the agent node, which runs a real bounded turn', async () => {
    await using t = await createTestApp(boot);
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
    const executor = new PlatformToolExecutor(
      server,
      t.app as unknown as Context,
      metaSource,
    );

    const sent: string[] = [];
    const agentToolCalls: string[] = [];

    const effects: WorkflowEffects = {
      gatherFacts: (spec, input) => {
        const f: RuleFacts = {};
        for (const [k, v] of Object.entries(spec)) {
          f[k] =
            v && typeof v === 'object' && '$input' in v
              ? input[(v as {$input: string}).$input]
              : v;
        }
        return f;
      },
      evaluateRule: (_ref, facts, now) =>
        ruleRuntime.evaluate(rulePlan, {
          facts,
          now,
          parameters: {},
          operatorRegistryVersion: V1,
        }),
      invokeCapability: capability => {
        sent.push(capability);
        return {delivered: true};
      },
      // The agent turn: the platform's real gated single-step turn dispatching a real agentback tool
      // via the executor. One decide (read slots) → compose (evidence-only) → replied.
      runAgentTurn: async () => {
        const decider: Decider = {
          propose: step =>
            step === 0
              ? {
                  kind: 'tool',
                  call: {
                    toolCallId: 'tc_assist' as ToolCall['toolCallId'],
                    capability: 'appointment.slot.read' as CapabilityName,
                    input: {date: '2026-07-12'},
                    idempotencyKey: 'idem-assist',
                    proposedAt: NOW as ToolCall['proposedAt'],
                  },
                  usage: noUsage,
                }
              : {
                  kind: 'done',
                  reply: 'Here are the open slots.',
                  usage: noUsage,
                },
        };
        const turn = await runTurn(
          testTurnRequest('Help the customer reschedule.'),
          {
            executor,
            decider,
            clock: {nowMs: () => 0},
          },
        );
        agentToolCalls.push(...turn.toolCalls.map(c => c.capability));
        return {
          outcome: turn.outcome === 'replied' ? 'replied' : turn.outcome,
          reply: turn.reply,
        };
      },
      now: () => NOW,
    };

    const result = await executeCompiledWorkflow(
      wfPlan,
      {input: {intent: 'complex'}},
      effects,
    );

    expect(result.path).toEqual(['triage', 'assist', 'end']);
    expect(result.outcome).toBe('completed');
    // the agent node actually dispatched a real agentback tool
    expect(agentToolCalls).toEqual(['appointment.slot.read']);
    // no deterministic capability reply on the agent path
    expect(sent).toHaveLength(0);
  });

  it('a simple intent routes to the deterministic capability reply (no agent turn)', async () => {
    const sent: string[] = [];
    let agentTurns = 0;

    const effects: WorkflowEffects = {
      gatherFacts: (spec, input) => {
        const f: RuleFacts = {};
        for (const [k, v] of Object.entries(spec)) {
          f[k] =
            v && typeof v === 'object' && '$input' in v
              ? input[(v as {$input: string}).$input]
              : v;
        }
        return f;
      },
      evaluateRule: (_ref, facts, now) =>
        ruleRuntime.evaluate(rulePlan, {
          facts,
          now,
          parameters: {},
          operatorRegistryVersion: V1,
        }),
      invokeCapability: capability => {
        sent.push(capability);
        return {delivered: true};
      },
      runAgentTurn: () => {
        agentTurns++;
        return {outcome: 'replied'};
      },
      now: () => NOW,
    };

    const result = await executeCompiledWorkflow(
      wfPlan,
      {input: {intent: 'simple'}},
      effects,
    );

    expect(result.path).toEqual(['triage', 'reply', 'end']);
    expect(sent).toEqual(['messaging.reply.send']);
    expect(agentTurns).toBe(0); // the common case never runs an agent turn
  });
});
