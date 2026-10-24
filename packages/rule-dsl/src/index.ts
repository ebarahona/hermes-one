// @hermes-one/rule-dsl — package (none plane).
// Rule compiler (→ content-hashed plan) + the pure RuleRuntime (ADR-015).

export {compileRule, RuleCompileError, type CompileOptions} from './compile.js';
export {
  RuleRuntimeImpl,
  createRuleRuntime,
  RuleEvaluationError,
} from './runtime.js';

export const descriptor = {
  name: '@hermes-one/rule-dsl',
  role: 'package',
  plane: 'none',
  published: true,
  governedBy: ['ADR-015'],
} as const;
