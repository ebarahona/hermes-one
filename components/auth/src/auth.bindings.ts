// AuthBindings — the `platform.auth.*` edge-plane binding keys, transcribed from
// authentication-strategies.md §"Configuration examples" (components/auth/src/auth.bindings.ts).
// Slice 2 declares the keys the api-key path uses + CONFIG; the oidc/session/webhook/service-identity
// verifier keys land with their strategies (Slice 4+). CONFIG is typed to the component's AuthConfig
// (the spec's import of AuthConfig from ./contracts is honored here; the spec's own contracts block
// omitted the type — a doc inconsistency the agent flagged).
import {BindingKey} from '@loopback/context';
import type {ApiKeyStore, PrincipalMapper} from '@platform/contracts';
import type {AuthConfig} from './contracts.js';
import type {AuthStrategyRegistry} from './auth-strategy.registry.js';

export namespace AuthBindings {
  export const STRATEGY_REGISTRY = BindingKey.create<AuthStrategyRegistry>('platform.auth.strategy-registry');
  export const PRINCIPAL_MAPPER = BindingKey.create<PrincipalMapper>('platform.auth.principal-mapper');
  export const API_KEY_STORE = BindingKey.create<ApiKeyStore>('platform.auth.api-key-store');
  export const CONFIG = BindingKey.create<AuthConfig>('platform.auth.config');
}
