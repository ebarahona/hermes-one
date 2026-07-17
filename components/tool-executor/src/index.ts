// @platform-internal/tool-executor — component (agent plane).
// Wraps agentback callTool + synthesizes the ToolResult envelope (ADR-018).

export {
  PlatformToolExecutor,
  metaSourceFrom,
  type CapabilityMeta,
  type CapabilityMetaSource,
  type DispatchResult,
  type ToolBindingSource,
} from './executor.js';
export {
  createEnvelopeHook,
  collectorFor,
  COLLECTOR_KEY,
  type TurnCollector,
} from './envelope-hook.js';

export const descriptor = {
  name: '@platform-internal/tool-executor',
  role: 'component',
  plane: 'agent',
  published: false,
  sourceDocs: ['04-agent-runtime/055'],
  governedBy: ['ADR-018'],
} as const;
