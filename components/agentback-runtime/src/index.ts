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
export {
  CapabilityToolProjector,
  CapabilityMetadataIndex,
  autonomousProjectionEnabled,
  type AgentbackToolOptions,
  type ToolRegistration,
  type ToolProjectionReport,
  type CapabilityMetadata,
  type ProjectionContext,
  type ProviderResolveFn,
} from './tool-projection.js';
export {jsonSchemaToZod, UnsupportedSchemaError} from './json-schema-to-zod.js';

export const descriptor = {
  name: '@platform-internal/agentback-runtime',
  role: 'component',
  plane: 'agent',
  published: false,
  sourceDocs: ['06-agentback/060', '063', 'agentback/tool-projection'],
  governedBy: ['ADR-013', 'ADR-017', 'ADR-018', 'ADR-020', 'ADR-021'],
} as const;
