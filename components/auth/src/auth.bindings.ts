// AuthBindings — the `platform.auth.*` edge-plane binding keys,
// The api-key increment declares the keys the api-key path uses + CONFIG; the oidc/session/webhook/service-identity
// verifier keys land with their strategies (later). CONFIG is typed to the component's AuthConfig
// (imported from ./contracts).
import {BindingKey} from '@loopback/context';
import type {
  ApiKeyStore,
  JwtVerifier,
  PrincipalMapper,
} from '@hermes-one/contracts';
import type {AuthConfig} from './contracts.js';
import type {AuthStrategyRegistry} from './auth-strategy.registry.js';

export namespace AuthBindings {
  export const STRATEGY_REGISTRY = BindingKey.create<AuthStrategyRegistry>(
    'platform.auth.strategy-registry',
  );
  export const PRINCIPAL_MAPPER = BindingKey.create<PrincipalMapper>(
    'platform.auth.principal-mapper',
  );
  export const API_KEY_STORE = BindingKey.create<ApiKeyStore>(
    'platform.auth.api-key-store',
  );
  export const JWT_VERIFIER = BindingKey.create<JwtVerifier>(
    'platform.auth.jwt-verifier',
  );
  export const CONFIG = BindingKey.create<AuthConfig>('platform.auth.config');
}
