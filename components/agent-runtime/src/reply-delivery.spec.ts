// Agent reply delivery across the turn's post-gate (ledger SP4, ADR-019): the workflow delivers the
// turn's FINAL reply. A real runTurn with a repairing post-gate feeds the interpreter, so the delivered
// body is the repaired text (never the flagged draft), and a repair that fails ends in a handoff that
// sends nothing.
import {describe, it, expect} from 'vitest';
import type {
  CompiledPolicyPlan,
  DefinitionId,
  IsoTimestamp,
  PlanId,
  PolicyRuntime,
  SemVer,
  TurnContext,
  WorkflowDefinition,
} from '@hermes-one/contracts';
import {
  compileWorkflow,
  executeCompiledWorkflow,
  type WorkflowEffects,
} from '@hermes-one/workflow-dsl';
import {runTurn, type Composer} from './index.js';
import {testTurnRequest, noUsage, FIXED_NOW} from './_test-fixtures.js';

const V1 = '1.0.0' as SemVer;
const NOW = '2026-10-24T00:00:00.000Z' as IsoTimestamp;

const wfPlan = compileWorkflow(
  {
    definitionId: 'def_reply_delivery_wf' as DefinitionId,
    kind: 'workflow',
    version: V1,
    body: {
      entry: 'assist',
      nodes: {
        assist: {
          id: 'assist',
          kind: 'agent',
          agentEngine: {
            definitionId: 'def_engine',
            version: V1,
            contentHash: `sha256:${'a'.repeat(64)}`,
          },
          objective: 'Answer the customer.',
          deliverReply: {
            capability: 'messaging.reply.send',
            input: {
              to: {$input: 'from'},
              template: 'agent_reply',
              body: {$agent: 'reply'},
            },
          },
          next: 'end',
        },
        end: {id: 'end', kind: 'terminal', outcome: 'completed'},
      },
    },
  } as unknown as WorkflowDefinition,
  {compilerVersion: V1, planId: 'pln_wf' as PlanId, compiledAt: NOW},
);

// Post-gate: 'repair' on the un-repaired draft, 'allow' once the reply is repaired.
const repairThenAllow: PolicyRuntime = {
  evaluatePreGates: () => ({
    outcome: 'allow',
    policyRuleId: '<default>',
    reason: 'ok',
    decidedAt: FIXED_NOW,
  }),
  evaluatePostGates: (_p, c) =>
    String((c as {draftReply?: string}).draftReply ?? '').startsWith(
      'repaired(',
    )
      ? {
          outcome: 'allow',
          policyRuleId: 'r_tone',
          reason: 'repaired ok',
          decidedAt: FIXED_NOW,
        }
      : {
          outcome: 'repair',
          policyRuleId: 'r_tone',
          reason: 'soften tone',
          detail: {repairInstruction: 'soften tone'},
          decidedAt: FIXED_NOW,
        },
  toVoters: () => [],
};

// A composer that honors the repair instruction (as a model-backed composer would).
const repairingComposer: Composer = (
  _ctx: TurnContext,
  _obj: string,
  fallback?: string,
  instruction?: string,
) =>
  instruction
    ? `repaired(${instruction}): ${fallback ?? 'ok'}`
    : (fallback ?? 'ok');

async function walk(compose?: Composer) {
  const sent: {capability: string; input: Record<string, unknown>}[] = [];
  const outcomes: string[] = [];
  const effects: WorkflowEffects = {
    gatherFacts: () => ({}),
    evaluateRule: () => ({outcome: 'default'}),
    invokeCapability: (capability, input) => {
      sent.push({capability, input});
      return {delivered: true};
    },
    runAgentTurn: async () => {
      const turn = await runTurn(testTurnRequest('reply please'), {
        executor: {} as never,
        decider: {
          propose: () => ({kind: 'done', reply: 'blunt reply', usage: noUsage}),
        },
        policy: {
          plan: {} as CompiledPolicyPlan,
          runtime: repairThenAllow,
        },
        ...(compose ? {compose} : {}),
        clock: {nowMs: () => 0},
      });
      outcomes.push(turn.outcome);
      return {outcome: turn.outcome, reply: turn.reply};
    },
    now: () => NOW,
  };
  const run = await executeCompiledWorkflow(
    wfPlan,
    {input: {channel: 'sms', from: '+15125550100', text: 'hi'}},
    effects,
  );
  return {run, sent, outcomes};
}

describe('agent reply delivery after the post-gate', () => {
  it('delivers the repaired reply, not the draft the policy flagged', async () => {
    const {run, sent, outcomes} = await walk(repairingComposer);
    expect(outcomes).toEqual(['replied']);
    expect(run.path).toEqual(['assist', 'end']);
    expect(sent).toEqual([
      {
        capability: 'messaging.reply.send',
        input: {
          to: '+15125550100',
          template: 'agent_reply',
          body: 'repaired(soften tone): blunt reply',
        },
      },
    ]);
  });

  it('sends nothing when the repair fails and the turn hands off', async () => {
    const {sent, outcomes} = await walk();
    expect(outcomes).toEqual(['handoff']);
    expect(sent).toHaveLength(0);
  });
});
