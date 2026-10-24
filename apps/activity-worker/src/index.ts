// @hermes-one/activity-worker — app (edge plane).
// Hosts the non-agent Temporal activities on task queue `hermes-activity`.

export {createActivityWorker, ACTIVITY_QUEUE} from './worker.js';

export const descriptor = {
  name: '@hermes-one/activity-worker',
  role: 'app',
  plane: 'edge',
  published: false,
  governedBy: [],
} as const;
