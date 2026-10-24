// @hermes-one/loopback-core — the edge-plane LB4 composition layer (decided
// 2026-07-14: the hand-rolled composition roots migrate onto this). Phase 1: PlatformBindings +
// the boundary contract + PlatformApplication + bootstrap() +
// the first five edge components (Persistence, Observability, CapabilityRegistry, RuleRuntime,
// PolicyRuntime). Phase 2 (pending): TenantCore (CT1/CT2), WorkflowCore/Temporal components,
// Channel/Memory/Bridge, the REST surface (RestApplication + sequence), interceptors, tags.

export const descriptor = {
  name: '@hermes-one/loopback-core',
  role: 'component',
  plane: 'edge',
  published: false,
  governedBy: ['ADR-017', 'ADR-022'],
} as const;

export {
  PlatformBindings,
  PlatformExtensionPoints,
  tenantKey,
} from './bindings.js';
export type {PlatformComponentBoundary} from './boundary.js';
export {PlatformApplication} from './application.js';
export {bootstrap} from './bootstrap.js';
export {
  PersistenceComponent,
  PostgresLifecycleObserver,
  RedisLifecycleObserver,
} from './components/persistence.component.js';
export {ObservabilityComponent} from './components/observability.component.js';
export {
  CapabilityRegistryComponent,
  IndexedCapabilityRegistry,
} from './components/capability-registry.component.js';
export {RuleRuntimeComponent} from './components/rule-runtime.component.js';
export {PolicyRuntimeComponent} from './components/policy-runtime.component.js';
export {SubstrateComponent} from './components/substrate.component.js';

// REST surface — the admin-api host.
export {PlatformRestApplication} from './rest-application.js';
export {
  PlatformSequenceGroups,
  PLATFORM_PRE_ROUTING_GROUPS,
} from './sequence/sequence-groups.js';
export {registerPlatformRestSequence} from './sequence/register.js';
export {REST_PUBLIC_PATHS} from './sequence/rest-bindings.js';
export {
  CorrelationMiddleware,
  CORRELATION_ID_REQUEST_KEY,
} from './sequence/correlation.middleware.js';
export {
  FailClosedAuthenticationMiddleware,
  DEFAULT_PUBLIC_PATHS,
} from './sequence/authentication.middleware.js';
export {PlatformReject} from './sequence/platform-reject.js';
