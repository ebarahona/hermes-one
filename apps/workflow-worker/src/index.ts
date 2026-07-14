// @platform-internal/workflow-worker — app (edge plane).
// Hosts the ONE Temporal workflow interpreter on task queue `hermes-workflow`.

export {createWorkflowWorker, WORKFLOW_QUEUE} from './worker.js';
export {ACTIVITY_QUEUE, AGENT_QUEUE} from './queues.js';
export {
  buildBundle,
  buildTriageBundle,
  bundleToRef,
  type RunBundle,
  type TriageBundle,
  type WorkflowRunRef,
  type PlanLoadRef,
} from './bundle.js';
export {publishBundle, publishAgentDeployment, E2E_TENANT} from './publish.js';

export const descriptor = {
  name: '@platform-internal/workflow-worker',
  role: 'app',
  plane: 'edge',
  published: false,
  sourceDocs: ['03-workflow-runtime/043', '17-deployment/170'],
  governedBy: ['ADR-014'],
} as const;
