// The no-LLM vertical slice, end-to-end (the deterministic rail, ADR-014/015).
//
// A missed inbound call flows: workflow interpreter → `rule` node DECIDES
// (eligible? out-of-area?) with ZERO model calls → routes to a `capability`
// node that sends a TEMPLATE reply through a stubbed channel → terminal. The
// whole path is deterministic and replay-safe. This is the platform's core
// scalability thesis in code: the common case never touches an LLM.
import {describe, it, expect} from 'vitest';
import type {
  DefinitionId,
  IsoTimestamp,
  PinnedRef,
  PlanId,
  RuleDefinition,
  RuleFacts,
  SemVer,
  WorkflowDefinition,
} from '@platform/contracts';
import {builtinRegistry} from '@platform/expression-core';
import {compileRule, createRuleRuntime} from '@platform/rule-dsl';
import {compileWorkflow} from './compile.js';
import {executeCompiledWorkflow, type WorkflowEffects} from './interpreter.js';

const V1 = '1.0.0' as SemVer;
const NOW = '2026-07-11T15:04:00.000Z' as IsoTimestamp;

// --- the deterministic decision (rule) ---------------------------------------
const registry = builtinRegistry(V1);
const ruleRuntime = createRuleRuntime(registry);

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
            {
              type: 'op',
              op: 'equals',
              args: [
                {type: 'fact', path: 'channel'},
                {type: 'literal', value: 'voice'},
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
const rulePlan = compileRule(missedCallRule, {
  registry,
  compilerVersion: V1,
  planId: 'pln_rule' as PlanId,
  compiledAt: NOW,
});
const ruleRef: PinnedRef = {
  definitionId: rulePlan.definitionId,
  version: rulePlan.version,
  contentHash: rulePlan.contentHash,
};

// --- the workflow (data walked by the one interpreter) -----------------------
// Authored as a plain literal; compileWorkflow's `.parse()` validates + brands.
const missedCallWorkflow = {
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
          answered: {$input: 'answered'},
          zip: {$input: 'zip'},
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
const wfPlan = compileWorkflow(
  missedCallWorkflow as unknown as WorkflowDefinition,
  {
    compilerVersion: V1,
    planId: 'pln_wf' as PlanId,
    compiledAt: NOW,
  },
);

// --- effects: real rule runtime + a stubbed channel --------------------------
function makeEffects() {
  const sent: {capability: string; input: Record<string, unknown>}[] = [];
  const effects: WorkflowEffects = {
    gatherFacts: (spec, input) => {
      const facts: RuleFacts = {};
      for (const [k, v] of Object.entries(spec)) {
        facts[k] =
          v && typeof v === 'object' && '$input' in v
            ? input[(v as {$input: string}).$input]
            : v;
      }
      return facts;
    },
    evaluateRule: (_ref, facts, now) => {
      const res = ruleRuntime.evaluate(rulePlan, {
        facts,
        now,
        parameters: {serviceZips: ['75001', '75002']},
        operatorRegistryVersion: V1,
      });
      return {outcome: res.outcome, emit: res.emit};
    },
    invokeCapability: (capability, input) => {
      sent.push({capability, input}); // the stubbed channel records the outbound
      return {delivered: true};
    },
    now: () => NOW,
  };
  return {effects, sent};
}

describe('no-LLM vertical slice: missed-call → rule → template reply', () => {
  it('an eligible in-area missed call sends a template reply (zero LLM calls)', async () => {
    const {effects, sent} = makeEffects();
    const result = await executeCompiledWorkflow(
      wfPlan,
      {
        input: {
          channel: 'voice',
          answered: false,
          zip: '75001',
          from: '+15551234',
        },
      },
      effects,
    );

    expect(result.outcome).toBe('completed');
    expect(result.path).toEqual(['eligibility', 'reply', 'end']);
    expect(sent).toEqual([
      {
        capability: 'messaging.reply.send',
        input: {template: 'missed_call_followup', to: '+15551234'},
      },
    ]);
  });

  it('an out-of-area call is decided away with NO reply sent', async () => {
    const {effects, sent} = makeEffects();
    const result = await executeCompiledWorkflow(
      wfPlan,
      {
        input: {
          channel: 'voice',
          answered: false,
          zip: '99999',
          from: '+15559999',
        },
      },
      effects,
    );

    expect(result.path).toEqual(['eligibility', 'end']);
    expect(sent).toHaveLength(0);
  });

  it('an answered call falls through to the default outcome (no action)', async () => {
    const {effects, sent} = makeEffects();
    const result = await executeCompiledWorkflow(
      wfPlan,
      {input: {channel: 'voice', answered: true, zip: '75001', from: '+1555'}},
      effects,
    );
    expect(result.path).toEqual(['eligibility', 'end']);
    expect(sent).toHaveLength(0);
  });

  it('is deterministic: identical input → identical path + effects (replay-safe)', async () => {
    const a = makeEffects();
    const b = makeEffects();
    const input = {
      input: {channel: 'voice', answered: false, zip: '75001', from: '+1555'},
    };
    const ra = await executeCompiledWorkflow(wfPlan, input, a.effects);
    const rb = await executeCompiledWorkflow(wfPlan, input, b.effects);
    expect(ra).toEqual(rb);
    expect(a.sent).toEqual(b.sent);
  });

  it('compiles the workflow to a content-hashed plan with derived edges', () => {
    expect(wfPlan.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(wfPlan.edges).toEqual(
      expect.arrayContaining([
        {from: 'eligibility', to: 'reply'},
        {from: 'eligibility', to: 'end'},
        {from: 'reply', to: 'end'},
      ]),
    );
  });
});
