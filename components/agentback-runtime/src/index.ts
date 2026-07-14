// @platform-internal/agentback-runtime — component (agent plane).
// The agent-plane @agentback Application + tool projection (ADR-017/021).

export {createAgentPlaneApp} from './app.js';
export {
  SpikeBookingTools,
  SlotReadInput,
  SlotReadOutput,
  BookingCreateInput,
  BookingCreateOutput,
} from './spike-tools.js';

export const descriptor = {
  name: '@platform-internal/agentback-runtime',
  role: 'component',
  plane: 'agent',
  published: false,
  sourceDocs: ['06-agentback/060', '063'],
  governedBy: ['ADR-017', 'ADR-021'],
} as const;
