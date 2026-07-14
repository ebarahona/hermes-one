import {describe, it, expect} from 'vitest';
import type {RuleExpression} from '@platform/contracts';
import {
  evaluateExpression,
  evaluatePredicate,
  ExpressionError,
} from './evaluate.js';
import {builtinRegistry} from './registry.js';

const registry = builtinRegistry();
const base = {facts: {}, parameters: {}, registry};

describe('expression-core evaluator', () => {
  it('resolves literal / fact / param nodes', () => {
    expect(evaluateExpression({type: 'literal', value: 7}, base)).toBe(7);
    expect(
      evaluateExpression(
        {type: 'fact', path: 'zip'},
        {...base, facts: {zip: '75001'}},
      ),
    ).toBe('75001');
    expect(
      evaluateExpression(
        {type: 'param', name: 'threshold'},
        {...base, parameters: {threshold: 5}},
      ),
    ).toBe(5);
  });

  it('resolves dotted fact paths', () => {
    expect(
      evaluateExpression(
        {type: 'fact', path: 'caller.zip'},
        {...base, facts: {caller: {zip: '75001'}}},
      ),
    ).toBe('75001');
  });

  it('applies operators and records a trace', () => {
    const expr: RuleExpression = {
      type: 'op',
      op: 'in',
      args: [
        {type: 'fact', path: 'zip'},
        {type: 'param', name: 'serviceZips'},
      ],
    };
    const trace: {op: string; args: unknown[]; result: unknown}[] = [];
    const out = evaluateExpression(expr, {
      facts: {zip: '75001'},
      parameters: {serviceZips: ['75001', '75002']},
      registry,
      trace,
    });
    expect(out).toBe(true);
    expect(trace).toEqual([
      {op: 'in', args: ['75001', ['75001', '75002']], result: true},
    ]);
  });

  it('composes and / or / not over boolean predicates', () => {
    const expr: RuleExpression = {
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
      ],
    };
    expect(
      evaluatePredicate(expr, {
        ...base,
        facts: {channel: 'voice', answered: false},
      }),
    ).toBe(true);
  });

  it('is deterministic: identical inputs → identical output', () => {
    const expr: RuleExpression = {
      type: 'op',
      op: 'greaterThan',
      args: [
        {type: 'fact', path: 'n'},
        {type: 'literal', value: 10},
      ],
    };
    const run = () => evaluateExpression(expr, {...base, facts: {n: 42}});
    expect(run()).toBe(run());
    expect(run()).toBe(true);
  });

  it('rejects a non-boolean operand to and/or/not', () => {
    expect(() =>
      evaluatePredicate(
        {type: 'not', expr: {type: 'fact', path: 'zip'}},
        {...base, facts: {zip: '75001'}},
      ),
    ).toThrow(ExpressionError);
  });

  it('throws on an unknown operator and on excessive depth', () => {
    expect(() =>
      evaluateExpression({type: 'op', op: 'nope', args: []}, base),
    ).toThrow(/unknown operator/);

    let deep: RuleExpression = {type: 'literal', value: true};
    for (let i = 0; i < 40; i++) deep = {type: 'not', expr: deep};
    expect(() => evaluateExpression(deep, base)).toThrow(/max depth/);
  });
});
