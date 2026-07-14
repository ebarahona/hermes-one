import {describe, expect, it} from 'vitest';
import {builtinRegistry} from '@platform/expression-core';
import type {
  DefinitionId,
  IsoTimestamp,
  PlanId,
  PolicyDefinition,
  PolicyEvaluationContext,
  Principal,
  SemVer,
} from '@platform/contracts';
import {compilePolicy, PolicyCompileError, ExpressionPolicyRuntime} from './index.js';

const AT = '2026-07-12T00:00:00.000Z' as IsoTimestamp;
const V1 = '1.0.0' as SemVer;
const reg = builtinRegistry();

const basePolicy = (rules: PolicyDefinition['body']['rules']): PolicyDefinition => ({
  definitionId: 'def_policy' as DefinitionId,
  kind: 'policy',
  version: V1,
  body: {rules, defaultVoterVerdict: 'deny', parameters: []},
});

const policy = basePolicy([
  {id: 'r_pre_budget', site: 'preGate', appliesTo: [], when: {type: 'fact', path: 'budgetExceeded'}, effect: 'deny', reason: 'over budget'},
  {id: 'r_post_pii', site: 'postGate', appliesTo: [], when: {type: 'fact', path: 'containsPII'}, effect: 'repair', reason: 'redact', detail: {repairInstruction: 'remove PII'}},
  {id: 'r_vote_write', site: 'voter', appliesTo: ['*.write'], when: {type: 'not', expr: {type: 'fact', path: 'consented'}}, effect: 'deny', reason: 'no consent'},
]);

const compile = (p: PolicyDefinition) =>
  compilePolicy(p, {registry: reg, compilerVersion: V1, planId: 'pln_pol' as PlanId, compiledAt: AT});

const ctx = (facts: Record<string, unknown>): PolicyEvaluationContext => ({
  principal: {id: 'prn_x', tenantId: 'tnt_x', kind: 'user', roles: [], scopes: [], attributes: {}} as unknown as Principal,
  facts,
  now: AT,
  parameters: {},
});

describe('compilePolicy', () => {
  it('splits rules by site into voters / preGates / postGates', () => {
    const plan = compile(policy);
    expect(plan.kind).toBe('policy');
    expect(plan.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.preGates.map(g => g.policyRuleId)).toEqual(['r_pre_budget']);
    expect(plan.postGates.map(g => g.policyRuleId)).toEqual(['r_post_pii']);
    expect(plan.voters.map(v => v.policyRuleId)).toEqual(['r_vote_write']);
    expect(plan.voters[0].verdict).toBe('deny');
    expect(plan.defaultVoterVerdict).toBe('deny');
  });

  it('rejects a voter effect that is not allow/deny', () => {
    const bad = basePolicy([
      {id: 'v', site: 'voter', appliesTo: ['*'], when: {type: 'literal', value: true}, effect: 'defer', reason: 'x'},
    ]);
    expect(() => compile(bad)).toThrow(PolicyCompileError);
  });

  it('rejects repair outside postGate and defer/approval/handoff outside preGate', () => {
    const repairPre = basePolicy([
      {id: 'g', site: 'preGate', appliesTo: [], when: {type: 'literal', value: true}, effect: 'repair', reason: 'x'},
    ]);
    const deferPost = basePolicy([
      {id: 'g', site: 'postGate', appliesTo: [], when: {type: 'literal', value: true}, effect: 'defer', reason: 'x'},
    ]);
    expect(() => compile(repairPre)).toThrow(/repair/);
    expect(() => compile(deferPost)).toThrow(/preGate-only/);
  });
});

describe('ExpressionPolicyRuntime', () => {
  const rt = new ExpressionPolicyRuntime(reg);
  const plan = compile(policy);

  it('pre-gate: first firing gate wins, else allow', () => {
    expect(rt.evaluatePreGates(plan, ctx({budgetExceeded: true}))).toMatchObject({
      outcome: 'deny',
      policyRuleId: 'r_pre_budget',
    });
    expect(rt.evaluatePreGates(plan, ctx({budgetExceeded: false}))).toMatchObject({
      outcome: 'allow',
      policyRuleId: '<none>',
    });
  });

  it('post-gate: PII draft yields repair', () => {
    expect(rt.evaluatePostGates(plan, ctx({containsPII: true}))).toMatchObject({outcome: 'repair'});
    expect(rt.evaluatePostGates(plan, ctx({containsPII: false})).outcome).toBe('allow');
  });

  it('toVoters is identity projection', () => {
    expect(rt.toVoters(plan)).toHaveLength(1);
    expect(rt.toVoters(plan)[0].verdict).toBe('deny');
  });
});
