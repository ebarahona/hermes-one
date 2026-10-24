// The shared expression evaluator (ADR-016): a PURE tree-walk over
// RuleExpression, reused by workflow branch predicates, rules, and policy. No
// I/O, no clock — facts (including `now`) are provided. Operators are resolved
// from the registry and called with resolved argument values.
import type {RuleExpression, RuleFacts} from '@hermes-one/contracts';
import type {OperatorRegistry} from './registry.js';

export interface TraceEntry {
  op: string;
  args: unknown[];
  result: unknown;
}

export interface EvalOptions {
  facts: RuleFacts;
  parameters: Record<string, unknown>;
  registry: OperatorRegistry;
  /** Sink for operator-call trace (audit/eval). */
  trace?: TraceEntry[];
  /** Guard against pathological nesting (default 32). */
  maxDepth?: number;
}

export class ExpressionError extends Error {}

/** Resolve a fact path (flat key first, then dotted traversal). */
function resolveFact(facts: RuleFacts, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(facts, path)) return facts[path];
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) =>
        acc != null && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[k]
          : undefined,
      facts,
    );
}

function asBool(v: unknown, ctx: string): boolean {
  if (typeof v !== 'boolean') {
    throw new ExpressionError(
      `${ctx}: expected a boolean, got ${JSON.stringify(v)}`,
    );
  }
  return v;
}

/** Evaluate an expression to its value. `and`/`or`/`not` require boolean operands. */
export function evaluateExpression(
  expr: RuleExpression,
  opts: EvalOptions,
  depth = 0,
): unknown {
  const maxDepth = opts.maxDepth ?? 32;
  if (depth > maxDepth) {
    throw new ExpressionError(`expression exceeds max depth ${maxDepth}`);
  }
  const rec = (e: RuleExpression) => evaluateExpression(e, opts, depth + 1);

  switch (expr.type) {
    case 'literal':
      return expr.value;
    case 'fact':
      return resolveFact(opts.facts, expr.path);
    case 'param':
      return opts.parameters[expr.name];
    case 'and':
      return expr.all.every(e => asBool(rec(e), 'and'));
    case 'or':
      return expr.any.some(e => asBool(rec(e), 'or'));
    case 'not':
      return !asBool(rec(expr.expr), 'not');
    case 'op': {
      const operator = opts.registry.resolve(expr.op);
      if (!operator) {
        throw new ExpressionError(`unknown operator '${expr.op}'`);
      }
      const args = expr.args.map(rec);
      const result = operator.evaluate(args, opts.facts);
      opts.trace?.push({op: expr.op, args, result});
      return result;
    }
  }
}

/** Evaluate an expression expected to be a boolean predicate. */
export function evaluatePredicate(
  expr: RuleExpression,
  opts: EvalOptions,
): boolean {
  return asBool(evaluateExpression(expr, opts), 'predicate');
}
