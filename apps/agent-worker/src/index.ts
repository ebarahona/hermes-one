// @platform-internal/agent-worker — app (agent plane).
// Hosts the bounded agent-turn activity on task queue `hermes-agent`.

export {createAgentWorker, AGENT_QUEUE} from './worker.js';

export const descriptor = {
  name: '@platform-internal/agent-worker',
  role: 'app',
  plane: 'agent',
  published: false,
  governedBy: ['ADR-021'],
} as const;
