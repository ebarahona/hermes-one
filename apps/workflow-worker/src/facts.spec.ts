import {describe, expect, it} from 'vitest';
import {gatherFacts, readInputPath} from './facts.js';

describe('readInputPath', () => {
  it('reads top-level keys directly', () => {
    expect(readInputPath({answered: false, zip: '75001'}, 'zip')).toBe('75001');
    expect(readInputPath({answered: false}, 'answered')).toBe(false);
    expect(readInputPath({}, 'missing')).toBeUndefined();
  });

  it('walks dotted paths through nested objects', () => {
    const input = {meta: {answered: false, geo: {zip: '75001'}}};
    expect(readInputPath(input, 'meta.answered')).toBe(false);
    expect(readInputPath(input, 'meta.geo.zip')).toBe('75001');
  });

  it('yields undefined when a segment is missing or not an object', () => {
    const input = {meta: {zip: '75001'}, text: 'hi', none: null};
    expect(readInputPath(input, 'meta.answered')).toBeUndefined();
    expect(readInputPath(input, 'nope.zip')).toBeUndefined();
    expect(readInputPath(input, 'text.length')).toBeUndefined();
    expect(readInputPath(input, 'none.x')).toBeUndefined();
    expect(readInputPath(input, 'meta.toString')).toBeUndefined();
  });

  it('prefers an existing top-level key that contains a dot', () => {
    expect(
      readInputPath({'meta.zip': 'flat', meta: {zip: 'nested'}}, 'meta.zip'),
    ).toBe('flat');
  });
});

describe('gatherFacts', () => {
  it('resolves $input bindings (top-level and dotted) and passes literals through', () => {
    const facts = gatherFacts(
      {
        channel: {$input: 'channel'},
        answered: {$input: 'meta.answered'},
        zip: {$input: 'meta.zip'},
        fixed: 'literal',
      },
      {channel: 'voice', from: '+1', meta: {answered: false, zip: '75001'}},
    );
    expect(facts).toEqual({
      channel: 'voice',
      answered: false,
      zip: '75001',
      fixed: 'literal',
    });
  });
});
