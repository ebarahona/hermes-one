// @hermes-one/workflow-dsl — package (none plane).
// The workflow compiler + the ONE interpreter, executeCompiledWorkflow (ADR-014).

export {
  compileWorkflow,
  WorkflowCompileError,
  type WorkflowCompileOptions,
} from './compile.js';
export {
  executeCompiledWorkflow,
  WorkflowError,
  type WorkflowEffects,
  type WorkflowRun,
  type WorkflowRunResult,
} from './interpreter.js';

export const descriptor = {
  name: '@hermes-one/workflow-dsl',
  role: 'package',
  plane: 'none',
  published: true,
  governedBy: ['ADR-014'],
} as const;
