// @hermes-one/expression-core — package (none plane).
// The shared pure expression evaluator + operator registry (ADR-016).

export {
  evaluateExpression,
  evaluatePredicate,
  ExpressionError,
  type EvalOptions,
  type TraceEntry,
} from './evaluate.js';
export {
  InMemoryOperatorRegistry,
  builtinRegistry,
  type OperatorRegistry,
} from './registry.js';
export {BUILTIN_OPERATORS} from './operators.js';

export const descriptor = {
  name: '@hermes-one/expression-core',
  role: 'package',
  plane: 'none',
  published: true,
  governedBy: ['ADR-016'],
} as const;
