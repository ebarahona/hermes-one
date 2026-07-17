// @platform/capability-contract — package (none plane).
// The capability plane: contract registry (validate + pin), ranked provider resolution over the
// ProviderMapping, scope-gated tool derivation, and the real capability invocation path that
// synthesizes the ADR-018 ToolResult envelope.

export {InMemoryCapabilityRegistry} from './registry.js';
export {ProviderRegistry} from './provider-registry.js';
export {ProviderResolver, NoProviderError} from './resolver.js';
export {deriveIdempotencyKey} from './idempotency.js';
export {capabilitiesForEngine, scopeSatisfies} from './tools.js';
export {
  CapabilityInvoker,
  type CapabilityLookup,
  type ProviderMappingOverrideLookup,
  type InvokeContext,
} from './invoker.js';

export const descriptor = {
  name: '@platform/capability-contract',
  role: 'package',
  plane: 'none',
  published: true,
  sourceDocs: ['07-capabilities/072', 'contracts/capability-contracts', 'contracts/provider-contracts'],
  governedBy: ['ADR-010', 'ADR-016', 'ADR-018', 'ADR-020'],
} as const;
