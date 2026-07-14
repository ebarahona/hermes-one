// @platform/workflow-dsl — package (none plane).
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
  name: '@platform/workflow-dsl',
  role: 'package',
  plane: 'none',
  published: true,
  sourceDocs: ['03-workflow-runtime/041', '042'],
  governedBy: ['ADR-014'],
} as const;
