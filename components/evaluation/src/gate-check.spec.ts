import {describe, expect, it} from 'vitest';
import type {
  DeploymentRef,
  EvaluationResult,
  EvaluationRunner,
  GoldenConversationCase,
  IsoTimestamp,
  SemVer,
  TenantId,
} from '@hermes-one/contracts';
import {DefaultRegressionGate} from './runner.js';
import {runBehavioralRegression, combineGateResults} from './gate-check.js';

const NOW = '2026-07-13T00:00:00.000Z' as IsoTimestamp;
const DEPLOY: DeploymentRef = {
  deploymentId: 'dpl_x' as DeploymentRef['deploymentId'],
  tenantId: 'tnt_x' as TenantId,
  version: '1.0.0' as SemVer,
};

const gcase = (
  caseId: string,
  severity: 'required' | 'advisory',
): GoldenConversationCase => ({
  caseId,
  tenantId: null,
  vertical: null,
  name: caseId,
  severity,
  turns: [{text: 'x', attachments: []}],
  assertions: [{kind: 'turn-outcome', outcome: 'replied'}],
  version: '1.0.0' as SemVer,
  updatedAt: NOW,
  updatedBy: 'prn_a',
});
const result = (caseId: string, passed: boolean): EvaluationResult => ({
  caseId,
  deploymentRef: DEPLOY,
  passed,
  assertionResults: [],
  ranAt: NOW,
  dryRun: true,
});

/** A runner that returns pre-baked results keyed by caseId. */
const runnerFor = (results: Record<string, boolean>): EvaluationRunner => ({
  runCase: async c => result(c.caseId, results[c.caseId] ?? true),
  runSuite: async cases =>
    cases.map(c => result(c.caseId, results[c.caseId] ?? true)),
});

describe('runBehavioralRegression', () => {
  const gate = new DefaultRegressionGate();

  it('passes when all required cases pass', async () => {
    const cases = [gcase('r1', 'required'), gcase('a1', 'advisory')];
    const r = await runBehavioralRegression(
      runnerFor({r1: true, a1: true}),
      gate,
      cases,
      DEPLOY,
    );
    expect(r.pass).toBe(true);
  });

  it('blocks with the failed case ids when a required case fails', async () => {
    const cases = [gcase('r1', 'required'), gcase('a1', 'advisory')];
    const r = await runBehavioralRegression(
      runnerFor({r1: false, a1: false}),
      gate,
      cases,
      DEPLOY,
    );
    expect(r.pass).toBe(false);
    expect(r.failedCaseIds).toEqual(['r1']); // advisory failure ignored
  });
});

describe('combineGateResults', () => {
  it('passes only when every gate passes', () => {
    expect(combineGateResults([{pass: true}, {pass: true}]).pass).toBe(true);
  });

  it('fails if any gate fails, joining reasons and case ids', () => {
    const r = combineGateResults([
      {pass: false, reason: 'behavioral', failedCaseIds: ['r1']},
      {pass: false, reason: 'scalability: cost_per_turn_usd'},
    ]);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('behavioral');
    expect(r.reason).toContain('scalability');
    expect(r.failedCaseIds).toEqual(['r1']);
  });
});
