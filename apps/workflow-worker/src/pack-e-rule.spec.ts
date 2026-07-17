// The electrician pack's triage rule must actually DECIDE — not merely compile. It shipped with
// literal branches (`when: {literal:false}` / `{literal:true}`), which compile and evaluate but
// discriminate nothing: every caller took the same branch regardless of what they said. This reads
// the REAL pack.json and drives the REAL compiler + runtime, so a regression to literals fails here.
import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {compileRule, createRuleRuntime} from '@platform/rule-dsl';
import {builtinRegistry} from '@platform/expression-core';
import type {IsoTimestamp, PlanId, SemVer} from '@platform/contracts';

const V1 = '1.0.0' as SemVer;
const NOW = '2026-07-17T00:00:00.000Z' as IsoTimestamp;
// Rules are pure over PROVIDED facts (ADR-015): time is a fact, and operators are version-pinned.
const evalCtx = (intent: string) => ({facts: {intent}, parameters: {}, now: NOW, operatorRegistryVersion: V1});

function triagePlan() {
  const pack = JSON.parse(readFileSync(join(process.cwd(), 'verticals/electrician/pack.json'), 'utf8'));
  const def = pack.definitions.rules.find((r: {name: string}) => r.name === 'electrician-triage');
  return compileRule(
    {
      ...def,
      tenantId: 'tnt_rule_spec',
      status: 'draft',
      labels: {},
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
      createdBy: 'prn_spec',
    } as never,
    {registry: builtinRegistry(V1), compilerVersion: V1, planId: 'pln_triage_spec' as PlanId, compiledAt: NOW},
  );
}

describe('electrician-triage rule (pack data)', () => {
  const cases: Array<[string, string]> = [
    ['my breaker keeps tripping and there is a faint burning smell near the panel', 'emergency'],
    ['I can see sparks coming from the outlet', 'emergency'],
    ['nothing urgent — what appointment slots do you have open on 2026-07-20?', 'schedule'],
    ['can someone come out next week to look at a light switch?', 'schedule'],
    // Matches no term — the caller still reaches the dispatcher, which triages in prose.
    ['my outlet stopped working', 'schedule'],
  ];

  it.each(cases)('routes %j → %s', async (intent, expected) => {
    const rt = createRuleRuntime(builtinRegistry(V1));
    const r = await rt.evaluate(triagePlan(), evalCtx(intent));
    expect(r.outcome).toBe(expected);
  });

  it('discriminates: an emergency and a scheduling ask do NOT take the same branch', async () => {
    const rt = createRuleRuntime(builtinRegistry(V1));
    const plan = triagePlan();
    const hazard = await rt.evaluate(plan, evalCtx('burning smell'));
    const booking = await rt.evaluate(plan, evalCtx('what slots are available'));
    expect(hazard.outcome).not.toBe(booking.outcome);
  });

  // A hazard outranks a booking ask even when the caller mentions both — branch ORDER carries this,
  // so a reorder that puts `schedule` first would silently downgrade an emergency.
  it('prioritises the hazard when a caller reports both', async () => {
    const rt = createRuleRuntime(builtinRegistry(V1));
    const r = await rt.evaluate(
      triagePlan(),
      evalCtx('there is a burning smell — can I also book an appointment for next week?'),
    );
    expect(r.outcome).toBe('emergency');
  });

  it('declares the fact it reads, so a caller-less invocation is a contract error not a silent default', () => {
    expect(triagePlan().requiredFacts ?? []).toContain('intent');
  });
});
