// @platform-internal/auth — edge component (AUTH-3, loopback/authentication-strategies.md).
// The edge authentication plane: strategy registry (extension point), principal mapper, and the
// api-key strategy + its config/seed-backed store. Wired into the LB4 REST sequence's authentication
// slot (loopback-core). oidc/bearer + Redis session/JWKS verifiers layer in next (Slice 4).
export const descriptor = {
  name: '@platform-internal/auth',
  role: 'component',
  plane: 'edge',
  published: false,
  sourceDocs: ['loopback/authentication-strategies', 'loopback/authorization-voters'],
  governedBy: ['ADR-017', 'ADR-019', 'ADR-022'],
} as const;

export {AuthComponent} from './auth.component.js';
export {AuthBindings} from './auth.bindings.js';
export {
  AuthStrategyRegistry,
  AUTH_STRATEGIES_EXTENSION_POINT,
  AUTH_STRATEGY_EXTENSION_TYPE,
} from './auth-strategy.registry.js';
export {DefaultPrincipalMapper} from './principal-mapper.js';
export {ApiKeyStrategy} from './api-key.strategy.js';
export {StaticApiKeyStore, type ApiKeySeed, type ApiKeyHashAlgo} from './static-api-key-store.js';
export {type AuthStrategy, AuthConfig, unauthorizedError} from './contracts.js';
export {assertScope, forbiddenScopeError} from './authorize.js';
