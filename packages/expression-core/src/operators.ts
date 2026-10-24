// Built-in rule operators (ADR-015). Every operator is PURE — a function over
// (args, facts) with no I/O, no clock, no globals. New operators register the
// same way; the platform discovers tenant/vertical operators via the
// `rule.operator` extension type. Here we ship a deterministic core set.
import type {
  RuleFacts,
  RuleOperator,
  RuleOperatorSpec,
  SemVer,
} from '@hermes-one/contracts';

const V1 = '1.0.0' as SemVer;

/** Structural deep-equality (arrays/objects by value), for `equals`. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  }
  return false;
}

/** Order-insensitive canonicalization of plain objects for stable comparison. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([k, val]) => [k, canonical(val)]),
    );
  }
  return v;
}

function op<A extends readonly unknown[], R>(
  spec: Omit<RuleOperatorSpec, 'pure'>,
  evaluate: (args: A, facts: RuleFacts) => R,
): RuleOperator<A, R> {
  return {spec: {...spec, pure: true}, evaluate};
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n))
    throw new Error(`operator: expected a number, got ${JSON.stringify(v)}`);
  return n;
};

/** The deterministic core operator set. */
export const BUILTIN_OPERATORS: RuleOperator[] = [
  op({op: 'equals', arity: 2, version: V1, returns: 'boolean'}, ([a, b]) =>
    deepEqual(a, b),
  ),
  op(
    {op: 'notEquals', arity: 2, version: V1, returns: 'boolean'},
    ([a, b]) => !deepEqual(a, b),
  ),
  op(
    {op: 'greaterThan', arity: 2, version: V1, returns: 'boolean'},
    ([a, b]) => num(a) > num(b),
  ),
  op(
    {op: 'greaterThanOrEqual', arity: 2, version: V1, returns: 'boolean'},
    ([a, b]) => num(a) >= num(b),
  ),
  op(
    {op: 'lessThan', arity: 2, version: V1, returns: 'boolean'},
    ([a, b]) => num(a) < num(b),
  ),
  op(
    {op: 'lessThanOrEqual', arity: 2, version: V1, returns: 'boolean'},
    ([a, b]) => num(a) <= num(b),
  ),
  // contains: `contains(haystack, needle)` — array membership or substring.
  op(
    {op: 'contains', arity: 2, version: V1, returns: 'boolean'},
    ([hay, needle]) => {
      if (Array.isArray(hay)) return hay.some(x => deepEqual(x, needle));
      if (typeof hay === 'string') return hay.includes(String(needle));
      throw new Error('contains: first arg must be an array or string');
    },
  ),
  // in: `in(needle, haystack)` — the ergonomic inverse of contains.
  op({op: 'in', arity: 2, version: V1, returns: 'boolean'}, ([needle, hay]) => {
    if (Array.isArray(hay)) return hay.some(x => deepEqual(x, needle));
    if (typeof hay === 'string') return hay.includes(String(needle));
    throw new Error('in: second arg must be an array or string');
  }),
  // lower: `lower(value)` — the string lowercased (locale-independent), for case-insensitive
  // matching (`contains(lower(fact), 'term')`). An absent value reads as the empty string.
  op({op: 'lower', arity: 1, version: V1, returns: 'string'}, ([v]) => {
    if (v == null) return '';
    if (typeof v === 'string') return v.toLowerCase();
    throw new Error('lower: arg must be a string');
  }),
  op({op: 'isEmpty', arity: 1, version: V1, returns: 'boolean'}, ([v]) => {
    if (v == null) return true;
    if (Array.isArray(v) || typeof v === 'string') return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  }),
];
