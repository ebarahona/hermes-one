import {describe, it, expect} from 'vitest';
import type {RuleExpression} from '@hermes-one/contracts';
import {evaluateExpression, evaluatePredicate} from './evaluate.js';
import {builtinRegistry} from './registry.js';

const registry = builtinRegistry();
const lower = (value: unknown) =>
  evaluateExpression(
    {type: 'op', op: 'lower', args: [{type: 'fact', path: 'v'}]},
    {facts: {v: value}, parameters: {}, registry},
  );

describe('lower operator', () => {
  it('is registered as a pure, unary, string-returning operator at 1.0.0', () => {
    expect(registry.resolve('lower')?.spec).toEqual({
      op: 'lower',
      arity: 1,
      version: '1.0.0',
      returns: 'string',
      pure: true,
    });
  });

  it('lowercases a string', () => {
    expect(lower('My Password RESET')).toBe('my password reset');
    expect(lower('already lower')).toBe('already lower');
  });

  it('reads an absent value as the empty string', () => {
    expect(lower(undefined)).toBe('');
    expect(lower(null)).toBe('');
  });

  it('rejects a non-string value', () => {
    expect(() => lower(42)).toThrow(/lower: arg must be a string/);
    expect(() => lower(['A'])).toThrow(/lower: arg must be a string/);
  });

  it('composes with contains for case-insensitive matching', () => {
    const expr: RuleExpression = {
      type: 'op',
      op: 'contains',
      args: [
        {type: 'op', op: 'lower', args: [{type: 'fact', path: 'text'}]},
        {type: 'literal', value: 'outage'},
      ],
    };
    const run = (text: string) =>
      evaluatePredicate(expr, {facts: {text}, parameters: {}, registry});
    expect(run('Is there an OUTAGE right now?')).toBe(true);
    expect(run('Outage in my region')).toBe(true);
    expect(run('all good here')).toBe(false);
  });
});
