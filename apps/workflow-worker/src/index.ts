// @hermes-one/workflow-worker — app (edge plane).
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
export {
  installVerticalPack,
  installElectricianPack,
  ELECTRICIAN_PACK,
  type VerticalInstall,
} from './pack-e-install.js';

export const descriptor = {
  name: '@hermes-one/workflow-worker',
  role: 'app',
  plane: 'edge',
  published: false,
  governedBy: ['ADR-014'],
} as const;
