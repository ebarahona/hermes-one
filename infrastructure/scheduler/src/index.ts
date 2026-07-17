// @platform-internal/scheduler — infrastructure (none plane). See internal-scheduler-provider.ts for
// why this exists and why it is config-driven rather than table-backed.
export {
  InternalSchedulerProvider,
  type SlotReadInput,
  type SlotReadResult,
} from './internal-scheduler-provider.js';

export const descriptor = {
  name: '@platform-internal/scheduler',
  role: 'infrastructure',
  plane: 'none',
  published: false,
  sourceDocs: ['contracts/provider-contracts', 'agentback/tool-projection'],
  governedBy: ['ADR-013'],
} as const;
