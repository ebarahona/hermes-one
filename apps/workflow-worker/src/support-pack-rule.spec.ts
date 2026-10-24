// The support pack's triage rule decides which messages are answered deterministically and which need
// an agent turn. This reads the REAL verticals/support/pack.json and drives the REAL compilers,
// rule runtime, and workflow interpreter, so a change to the pack data that misroutes a message
// fails here — no Temporal, no LLM.
import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {compileRule, createRuleRuntime} from '@hermes-one/rule-dsl';
import {
  compileWorkflow,
  executeCompiledWorkflow,
} from '@hermes-one/workflow-dsl';
import {compilePolicy} from '@hermes-one/policy-dsl';
import {builtinRegistry} from '@hermes-one/expression-core';
import {
  AgentEngineContract,
  CapabilityContract,
  type InboundWorkflowInput,
  type IsoTimestamp,
  type PlanId,
  type SemVer,
} from '@hermes-one/contracts';
import {gatherFacts} from './facts.js';

const V1 = '1.0.0' as SemVer;
const NOW = '2026-10-24T00:00:00.000Z' as IsoTimestamp;

const pack = JSON.parse(
  readFileSync(join(process.cwd(), 'verticals/support/pack.json'), 'utf8'),
);

const authored = (def: Record<string, unknown>) =>
  ({
    ...def,
    tenantId: 'tnt_support_spec',
    status: 'draft',
    labels: {},
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'prn_spec',
  }) as never;

function triagePlan() {
  const def = pack.definitions.rules.find(
    (r: {name: string}) => r.name === 'support-triage',
  );
  return compileRule(authored(def), {
    registry: builtinRegistry(V1),
    compilerVersion: V1,
    planId: 'pln_support_triage_spec' as PlanId,
    compiledAt: NOW,
  });
}

const evalCtx = (text: string | undefined) => ({
  facts: {text},
  parameters: {},
  now: NOW,
  operatorRegistryVersion: V1,
});

async function outcomeOf(text: string | undefined): Promise<string> {
  const rt = createRuleRuntime(builtinRegistry(V1));
  return (await rt.evaluate(triagePlan(), evalCtx(text))).outcome;
}

describe('support-triage rule (pack data)', () => {
  const cases: Array<[string, string]> = [
    ['I forgot my password', 'password-reset'],
    ["I'm LOCKED OUT of my account", 'password-reset'],
    ["I can't log in since this morning", 'password-reset'],
    ['Can you resend my Invoice for March?', 'billing'],
    ['Where do I update my PAYMENT METHOD?', 'billing'],
    ['How do I turn on 2FA?', 'account-faq'],
    ['I want to Change My Email address', 'account-faq'],
    ['The dashboard IS DOWN for our whole team', 'escalate'],
    ['Is there an outage right now?', 'escalate'],
    ['I think my account was Hacked', 'escalate'],
    // Matches no term — the message needs judgment and reaches the support agent.
    [
      'Why do my usage numbers look different from last month?',
      'needs-judgment',
    ],
    ['Can I get a discount if we add ten more seats?', 'needs-judgment'],
  ];

  it.each(cases)('routes %j → %s', async (text, expected) => {
    expect(await outcomeOf(text)).toBe(expected);
  });

  it('matches regardless of case', async () => {
    for (const text of ['PASSWORD', 'password', 'PassWord'])
      expect(await outcomeOf(text)).toBe('password-reset');
  });

  // Branch ORDER carries this: an outage or security report outranks a simple intent in the same
  // message, so a reorder that puts password-reset first would silently answer a security report
  // with a template.
  it('prioritizes escalation when a message also names a simple intent', async () => {
    expect(
      await outcomeOf('Someone HACKED my account and changed my password'),
    ).toBe('escalate');
    expect(
      await outcomeOf('Billing page is down — I cannot download my invoice'),
    ).toBe('escalate');
  });

  it('routes a message with no text to the agent rather than failing', async () => {
    expect(await outcomeOf(undefined)).toBe('needs-judgment');
  });

  it('declares the fact it reads', () => {
    expect(triagePlan().requiredFacts ?? []).toContain('text');
  });
});

describe('support-intake workflow (pack data)', () => {
  // Pin the workflow's references by content hash, as the installer does; the agent engine is a
  // contract-schema member, so any well-formed hash stands in for it here.
  const wfDef = JSON.parse(JSON.stringify(pack.definitions.workflow));
  wfDef.body.nodes.triage.rule.contentHash = triagePlan().contentHash;
  wfDef.body.nodes.assist.agentEngine.contentHash = `sha256:${'0'.repeat(64)}`;
  const workflowPlan = compileWorkflow(authored(wfDef) as never, {
    compilerVersion: V1,
    planId: 'pln_support_wf_spec' as PlanId,
    compiledAt: NOW,
  });

  async function walk(
    text: string,
    turn: {outcome: string; reply?: string} = {outcome: 'replied', reply: 'ok'},
  ) {
    const rulePlan = triagePlan();
    const rt = createRuleRuntime(builtinRegistry(V1));
    const sent: Array<Record<string, unknown>> = [];
    let agentTurns = 0;
    const input: InboundWorkflowInput = {
      channel: 'sms',
      from: '+15125550100',
      text,
      meta: {},
    };
    const run = await executeCompiledWorkflow(
      workflowPlan,
      {input},
      {
        gatherFacts,
        evaluateRule: (_ref, facts, now) =>
          rt.evaluate(rulePlan, {
            facts,
            parameters: {},
            now,
            operatorRegistryVersion: V1,
          }),
        invokeCapability: (capability, capInput) => {
          sent.push({capability, ...capInput});
          return {delivered: true};
        },
        runAgentTurn: () => {
          agentTurns++;
          return turn;
        },
        now: () => NOW,
      },
    );
    return {run, sent, agentTurns};
  }

  it('answers a known simple intent with a templated reply and no agent turn', async () => {
    const {run, sent, agentTurns} = await walk('Forgot my password');
    expect(run.path).toEqual(['triage', 'password_reset', 'end']);
    expect(run.outcome).toBe('completed');
    expect(agentTurns).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      capability: 'messaging.reply.send',
      to: '+15125550100',
      template: 'support_password_reset',
    });
  });

  it('escalates an outage to a human deterministically, with a notice and no agent turn', async () => {
    const {run, sent, agentTurns} = await walk('Your API is down');
    expect(run.path).toEqual(['triage', 'escalation_notice', 'escalate']);
    expect(run.outcome).toBe('handoff');
    expect(run.output).toEqual({
      queue: 'urgent',
      reason: 'outage-or-security-report',
    });
    expect(agentTurns).toBe(0);
    expect(sent.map(s => s.template)).toEqual(['support_escalation_notice']);
  });

  it('hands a message that needs judgment to exactly one bounded agent turn and delivers its reply', async () => {
    const {run, sent, agentTurns} = await walk(
      'Which plan fits a team of twelve?',
      {outcome: 'replied', reply: 'The Team plan fits twelve people.'},
    );
    expect(run.path).toEqual(['triage', 'assist', 'end']);
    expect(agentTurns).toBe(1);
    expect(sent).toEqual([
      {
        capability: 'messaging.reply.send',
        to: '+15125550100',
        template: 'support_agent_reply',
        body: 'The Team plan fits twelve people.',
      },
    ]);
  });

  it('sends nothing when the agent turn hands off', async () => {
    const {run, sent, agentTurns} = await walk(
      'Which plan fits a team of twelve?',
      {outcome: 'handoff', reply: 'draft'},
    );
    expect(run.path).toEqual(['triage', 'assist', 'end']);
    expect(agentTurns).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('compiles the pack policy with the same operator registry', () => {
    const plan = compilePolicy(authored(pack.definitions.policy) as never, {
      registry: builtinRegistry(V1),
      compilerVersion: V1,
      planId: 'pln_support_policy_spec' as PlanId,
      compiledAt: NOW,
    });
    expect(plan.postGates.map(g => g.policyRuleId)).toEqual([
      'no-credential-request',
    ]);
  });

  // The contract-schema members are validated the way DefinitionRegistry.put validates them.
  it('carries an agent engine and capability that pass contract validation', () => {
    const base = (d: {
      definitionId: string;
      kind: string;
      version: string;
      schemaRef: string;
    }) => ({
      definitionId: d.definitionId,
      kind: d.kind,
      version: d.version,
      schemaRef: d.schemaRef,
      contentHash: `sha256:${'0'.repeat(64)}`,
      validatedAt: NOW,
    });
    const engine = pack.definitions.agentEngine;
    const parsedEngine = AgentEngineContract.parse({
      ...base(engine),
      body: engine.body,
    });
    expect(parsedEngine.body.allowedCapabilities).toEqual([]);
    expect(parsedEngine.body.model.model).toBe('');
    for (const cap of pack.definitions.capabilities)
      expect(
        CapabilityContract.safeParse({...base(cap), ...cap.body}).success,
      ).toBe(true);
  });
});
