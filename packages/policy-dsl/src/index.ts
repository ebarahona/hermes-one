// @platform/policy-dsl — package (none plane).
// Policy compiler (→ content-hashed CompiledPolicyPlan) + the pure ExpressionPolicyRuntime (ADR-019).

export {compilePolicy, PolicyCompileError, type CompileOptions} from './compile.js';
export {ExpressionPolicyRuntime} from './runtime.js';

export const descriptor = {
  name: '@platform/policy-dsl',
  role: 'package',
  plane: 'none',
  published: true,
  sourceDocs: ['13-security/132', 'security/policy-engine-runtime', 'contracts/policy-contracts'],
  governedBy: ['ADR-015', 'ADR-016', 'ADR-019'],
} as const;
