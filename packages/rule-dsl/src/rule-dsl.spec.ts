import {describe, it, expect} from 'vitest';
import type {
  DefinitionId,
  IsoTimestamp,
  PlanId,
  RuleDefinition,
  RuleEvaluationContext,
  RuleOperator,
  SemVer,
} from '@platform/contracts';
import {
  BUILTIN_OPERATORS,
  builtinRegistry,
  InMemoryOperatorRegistry,
} from '@platform/expression-core';
import {compileRule, RuleCompileError} from './compile.js';
import {createRuleRuntime, RuleEvaluationError} from './runtime.js';

const registry = builtinRegistry('1.0.0' as SemVer);
const compileOpts = {
  registry,
  compilerVersion: '1.0.0' as SemVer,
  planId: 'pln_test' as PlanId,
  compiledAt: '2026-07-11T00:00:00.000Z' as IsoTimestamp,
};

// A missed-call rule: a voice call that wasn't answered, in-area → call back.
const missedCallRule: RuleDefinition = {
  definitionId: 'def_missed_call' as DefinitionId,
  kind: 'rule',
  version: '1.0.0' as SemVer,
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
        emit: {template: 'missed_call_followup'},
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

function ctx(facts: Record<string, unknown>): RuleEvaluationContext {
  return {
    facts,
    now: '2026-07-11T15:04:00.000Z' as IsoTimestamp,
    parameters: {serviceZips: ['75001', '75002']},
    operatorRegistryVersion: '1.0.0' as SemVer,
  };
}

describe('rule-dsl compile', () => {
  it('compiles a definition to a content-hashed plan with pinned operators', () => {
    const plan = compileRule(missedCallRule, compileOpts);
    expect(plan.kind).toBe('rule');
    expect(plan.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // operators referenced are pinned by version, sorted, de-duped
    expect(plan.operatorRefs).toEqual([
      {op: 'equals', version: '1.0.0'},
      {op: 'in', version: '1.0.0'},
    ]);
  });

  it('produces a stable content hash for identical definitions', () => {
    const a = compileRule(missedCallRule, compileOpts);
    const b = compileRule(missedCallRule, {
      ...compileOpts,
      planId: 'pln_other' as PlanId,
    });
    // hash is over the plan's logic, not its volatile planId/compiledAt
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('rejects a definition referencing an unknown operator', () => {
    const bad: RuleDefinition = {
      ...missedCallRule,
      body: {
        ...missedCallRule.body,
        branches: [
          {outcome: 'x', when: {type: 'op', op: 'teleport', args: []}},
        ],
      },
    };
    expect(() => compileRule(bad, compileOpts)).toThrow(RuleCompileError);
  });

  const withWhen = (
    when: RuleDefinition['body']['branches'][0]['when'],
  ): RuleDefinition => ({
    ...missedCallRule,
    body: {...missedCallRule.body, branches: [{outcome: 'x', when}]},
  });

  it('rejects a wrong-arity expression → RULE_OPERATOR_ARITY', () => {
    const bad = withWhen({
      type: 'op',
      op: 'equals',
      args: [
        {type: 'fact', path: 'a'},
        {type: 'fact', path: 'b'},
        {type: 'fact', path: 'c'},
      ],
    });
    expect(() => compileRule(bad, compileOpts)).toThrow(/RULE_OPERATOR_ARITY/);
  });

  it('rejects an impure operator → RULE_OPERATOR_NOT_PURE (spec.pure asserted at compile)', () => {
    const impure: RuleOperator = {
      spec: {
        op: 'clock.now',
        arity: 0,
        version: '1.0.0' as SemVer,
        returns: 'boolean',
        pure: false as unknown as true,
      },
      evaluate: () => true,
    };
    const tainted = new InMemoryOperatorRegistry('1.0.0' as SemVer, [
      ...BUILTIN_OPERATORS,
      impure,
    ]);
    const bad = withWhen({type: 'op', op: 'clock.now', args: []});
    expect(() => compileRule(bad, {...compileOpts, registry: tainted})).toThrow(
      /RULE_OPERATOR_NOT_PURE/,
    );
  });

  it('rejects a non-boolean operator in a boolean position → RULE_OPERATOR_RETURN_TYPE', () => {
    const numeric: RuleOperator = {
      spec: {
        op: 'math.sum',
        arity: 2,
        version: '1.0.0' as SemVer,
        returns: 'number',
        pure: true,
      },
      evaluate: () => 0,
    };
    const extended = new InMemoryOperatorRegistry('1.0.0' as SemVer, [
      ...BUILTIN_OPERATORS,
      numeric,
    ]);
    const bad = withWhen({
      type: 'op',
      op: 'math.sum',
      args: [
        {type: 'literal', value: 1},
        {type: 'literal', value: 2},
      ],
    });
    expect(() =>
      compileRule(bad, {...compileOpts, registry: extended}),
    ).toThrow(/RULE_OPERATOR_RETURN_TYPE/);
  });

  it('bounds expression nesting → RULE_EXPRESSION_TOO_DEEP (maxExpressionDepth)', () => {
    let when: RuleDefinition['body']['branches'][0]['when'] = {
      type: 'fact',
      path: 'flag',
    };
    for (let i = 0; i < 5; i++) when = {type: 'not', expr: when};
    expect(() =>
      compileRule(withWhen(when), {...compileOpts, maxExpressionDepth: 4}),
    ).toThrow(/RULE_EXPRESSION_TOO_DEEP/);
    // the default bound (32) still accepts it
    expect(() => compileRule(withWhen(when), compileOpts)).not.toThrow();
  });
});

describe('rule-dsl runtime', () => {
  const runtime = createRuleRuntime(registry);
  const plan = compileRule(missedCallRule, compileOpts);

  it('first-match: an unanswered in-area voice call routes to callBack (with emit)', () => {
    const res = runtime.evaluate(
      plan,
      ctx({channel: 'voice', answered: false, zip: '75001'}),
    );
    expect(res.matched).toBe(true);
    expect(res.outcome).toBe('callBack');
    expect(res.emit).toEqual({template: 'missed_call_followup'});
    expect(res.trace.length).toBeGreaterThan(0);
    expect(res.evaluatedAt).toBe('2026-07-11T15:04:00.000Z');
  });

  it('routes an out-of-area call to outOfArea', () => {
    const res = runtime.evaluate(
      plan,
      ctx({channel: 'voice', answered: false, zip: '99999'}),
    );
    expect(res.outcome).toBe('outOfArea');
    expect(res.matched).toBe(true);
  });

  it('falls through to the default outcome when nothing matches', () => {
    const res = runtime.evaluate(
      plan,
      ctx({channel: 'sms', answered: false, zip: '75001'}),
    );
    expect(res.matched).toBe(false);
    expect(res.outcome).toBe('ignore');
  });

  it('is deterministic: identical (plan, ctx) → identical result (replay-safe)', () => {
    const c = ctx({channel: 'voice', answered: false, zip: '75001'});
    expect(runtime.evaluate(plan, c)).toEqual(runtime.evaluate(plan, c));
  });

  it('refuses a plan whose pinned operator version differs from the registry', () => {
    const staleRegistry = builtinRegistry('2.0.0' as SemVer); // operators still 1.0.0...
    // ...so pins still match; force a mismatch by hand-editing a ref:
    const tampered = {
      ...plan,
      operatorRefs: [{op: 'equals', version: '9.9.9' as SemVer}],
    };
    expect(() =>
      createRuleRuntime(staleRegistry).evaluate(
        tampered,
        ctx({channel: 'voice', answered: false, zip: '75001'}),
      ),
    ).toThrow(RuleEvaluationError);
  });
});
