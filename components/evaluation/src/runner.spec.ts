import {describe, expect, it} from 'vitest';
import type {
  DeploymentRef,
  EvaluationResult,
  GoldenConversationCase,
  IsoTimestamp,
  SemVer,
  TenantId,
  TurnResult,
} from '@hermes-one/contracts';
import type {TurnLedger} from '@hermes-one/agent-runtime';
import {
  DefaultEvaluationRunner,
  DefaultRegressionGate,
  scoreAssertion,
  type SimulateTurnFn,
} from './runner.js';
import type {TurnSimulationOutput} from './simulation.js';

const NOW = '2026-07-13T00:00:00.000Z' as IsoTimestamp;
const DEPLOY: DeploymentRef = {
  deploymentId: 'dpl_x' as DeploymentRef['deploymentId'],
  tenantId: 'tnt_x' as TenantId,
  version: '1.0.0' as SemVer,
};

/** Minimal TurnSimulationOutput for scoring (only the read fields matter). */
function out(o: {
  toolCaps?: string[];
  reply?: string;
  outcome?: TurnResult['outcome'];
  evidence?: string[];
  policy?: {site: 'voter' | 'preGate' | 'postGate'; outcome: string}[];
}): TurnSimulationOutput {
  return {
    result: {
      turnId: 'trn',
      outcome: o.outcome ?? 'replied',
      reply: o.reply,
      gateDecision: null,
      toolCalls: (o.toolCaps ?? []).map((c, i) => ({
        toolCallId: `tc${i}`,
        capability: c,
        input: {},
        idempotencyKey: `k${i}`,
        proposedAt: NOW,
      })),
      evidence: [],
      steps: 1,
      metrics: {modelCostUsd: 0, inputTokens: 0, outputTokens: 0, toolCount: 0},
      finishedAt: NOW,
    } as unknown as TurnResult,
    ledger: {
      turnId: 'trn',
      tenantId: 'tnt',
      correlationId: 'trn',
      toolExecutions: [],
      evidence: (o.evidence ?? []).map((s, i) => ({
        id: `e${i}`,
        turnId: 'trn',
        toolCallId: null,
        kind: 'tool-output',
        capability: null,
        statement: s,
        data: {},
        source: 'provider',
        trusted: false,
        observedAt: NOW,
      })),
      policyDecisions: (o.policy ?? []).map((p, i) => ({
        decisionId: `p${i}`,
        site: p.site,
        decision: {
          outcome: p.outcome,
          policyRuleId: 'r',
          reason: '',
          decidedAt: NOW,
        },
      })),
      usage: {modelCostUsd: 0, inputTokens: 0, outputTokens: 0, toolCount: 0},
    } as unknown as TurnLedger,
  };
}

describe('scoreAssertion', () => {
  const o = [
    out({
      toolCaps: ['appointment.slot.read'],
      reply: 'You are booked for 9am',
      outcome: 'replied',
      evidence: ['slots available: 9am, 11am'],
      policy: [
        {site: 'preGate', outcome: 'allow'},
        {site: 'postGate', outcome: 'allow'},
      ],
    }),
  ];

  it('scores every assertion kind (pass path)', () => {
    expect(
      scoreAssertion(
        {
          kind: 'tool-called',
          capability: 'appointment.slot.read',
          atStepOrLater: 0,
        },
        o,
      ).passed,
    ).toBe(true);
    expect(
      scoreAssertion(
        {kind: 'tool-not-called', capability: 'appointment.booking.create'},
        o,
      ).passed,
    ).toBe(true);
    expect(
      scoreAssertion({kind: 'evidence-contains', pattern: '9am'}, o).passed,
    ).toBe(true);
    expect(
      scoreAssertion({kind: 'reply-matches', pattern: 'booked'}, o).passed,
    ).toBe(true);
    expect(
      scoreAssertion(
        {kind: 'policy-outcome', site: 'postGate', outcome: 'allow'},
        o,
      ).passed,
    ).toBe(true);
    expect(
      scoreAssertion({kind: 'turn-outcome', outcome: 'replied'}, o).passed,
    ).toBe(true);
  });

  it('scores every assertion kind (fail path, with detail)', () => {
    expect(
      scoreAssertion(
        {kind: 'tool-called', capability: 'nope.x.y', atStepOrLater: 0},
        o,
      ).passed,
    ).toBe(false);
    expect(
      scoreAssertion(
        {kind: 'tool-not-called', capability: 'appointment.slot.read'},
        o,
      ).passed,
    ).toBe(false);
    expect(
      scoreAssertion({kind: 'evidence-contains', pattern: 'no-such'}, o).passed,
    ).toBe(false);
    expect(
      scoreAssertion({kind: 'reply-matches', pattern: 'cancelled'}, o).passed,
    ).toBe(false);
    expect(
      scoreAssertion(
        {kind: 'policy-outcome', site: 'preGate', outcome: 'deny'},
        o,
      ).passed,
    ).toBe(false);
    const f = scoreAssertion({kind: 'turn-outcome', outcome: 'handoff'}, o);
    expect(f.passed).toBe(false);
    expect(f.detail).toContain('handoff');
  });
});

const goldenCase = (
  over: Partial<GoldenConversationCase>,
): GoldenConversationCase => ({
  caseId: 'eval_1',
  tenantId: null,
  vertical: null,
  name: 'booking flow',
  severity: 'required',
  turns: [{text: 'book me for 9am', attachments: []}],
  assertions: [{kind: 'turn-outcome', outcome: 'replied'}],
  version: '1.0.0' as SemVer,
  updatedAt: NOW,
  updatedBy: 'prn_author',
  ...over,
});

describe('DefaultEvaluationRunner', () => {
  const simulate =
    (result: TurnSimulationOutput): SimulateTurnFn =>
    async () =>
      result;

  it('runs a case, scores assertions, and returns a dryRun EvaluationResult', async () => {
    const runner = new DefaultEvaluationRunner(
      simulate(
        out({
          reply: 'done',
          outcome: 'replied',
          toolCaps: ['appointment.slot.read'],
        }),
      ),
      () => new Date(NOW),
    );
    const r = await runner.runCase(
      goldenCase({
        assertions: [
          {kind: 'turn-outcome', outcome: 'replied'},
          {
            kind: 'tool-called',
            capability: 'appointment.slot.read',
            atStepOrLater: 0,
          },
        ],
      }),
      DEPLOY,
    );
    expect(r.passed).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.assertionResults).toHaveLength(2);
  });

  it('marks the case failed when any assertion fails', async () => {
    const runner = new DefaultEvaluationRunner(
      simulate(out({outcome: 'handoff'})),
      () => new Date(NOW),
    );
    const r = await runner.runCase(
      goldenCase({assertions: [{kind: 'turn-outcome', outcome: 'replied'}]}),
      DEPLOY,
    );
    expect(r.passed).toBe(false);
  });
});

describe('DefaultRegressionGate', () => {
  const gate = new DefaultRegressionGate();
  const result = (caseId: string, passed: boolean): EvaluationResult => ({
    caseId,
    deploymentRef: DEPLOY,
    passed,
    assertionResults: [],
    ranAt: NOW,
    dryRun: true,
  });

  it('passes when all required cases pass', () => {
    const cases = [goldenCase({caseId: 'r1', severity: 'required'})];
    expect(gate.evaluate([result('r1', true)], cases).pass).toBe(true);
  });

  it('blocks on a required-case failure', () => {
    const cases = [goldenCase({caseId: 'r1', severity: 'required'})];
    const g = gate.evaluate([result('r1', false)], cases);
    expect(g.pass).toBe(false);
    if (!g.pass) expect(g.failedCaseIds).toEqual(['r1']);
  });

  it('ignores an advisory-case failure (reports only)', () => {
    const cases = [goldenCase({caseId: 'a1', severity: 'advisory'})];
    expect(gate.evaluate([result('a1', false)], cases).pass).toBe(true);
  });
});
