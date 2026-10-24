// AuthComponent (edge) — binds the AUTH-3 auth plane: the AuthStrategyRegistry (extension point
// `platform.extensions.authStrategies`), the DefaultPrincipalMapper (sole writer of
// platform.request.principal), and contributes the api-key strategy as a tagged extension. The
// composition root supplies the request-shaped bits it can't: the ApiKeyStore (config/seed) and the
// AuthConfig — same split as the ChannelComponent + credential store. Slice 2 registers one strategy;
// oidc/bearer + its verifiers are added the same way (Slice 4).
import {Binding, BindingScope, type Component, CoreTags} from '@loopback/core';
import type {PlatformComponentBoundary} from '@hermes-one/loopback-core';
import {
  AUTH_STRATEGIES_EXTENSION_POINT,
  AUTH_STRATEGY_EXTENSION_TYPE,
  AuthStrategyRegistry,
} from './auth-strategy.registry.js';
import {AuthBindings} from './auth.bindings.js';
import {DefaultPrincipalMapper} from './principal-mapper.js';
import {ApiKeyStrategy} from './api-key.strategy.js';
import {OidcStrategy} from './oidc.strategy.js';

export class AuthComponent implements Component, PlatformComponentBoundary {
  readonly plane = 'edge' as const;
  readonly bindsKeys = [
    AuthBindings.STRATEGY_REGISTRY.key,
    AuthBindings.PRINCIPAL_MAPPER.key,
  ];
  readonly implementsExtensionPoints = [AUTH_STRATEGIES_EXTENSION_POINT];
  readonly consumesExtensionPoints: readonly string[] = [];
  readonly contributesTags = [AUTH_STRATEGY_EXTENSION_TYPE];

  bindings: Binding[] = [
    Binding.bind(AuthBindings.STRATEGY_REGISTRY.key)
      .toClass(AuthStrategyRegistry)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(AuthBindings.PRINCIPAL_MAPPER.key)
      .toClass(DefaultPrincipalMapper)
      .inScope(BindingScope.REQUEST),
    // Contribute the strategies to the extension point (discovered by the registry's @extensions()).
    // Strategy order (design 001): cheap-shape first — api-key before oidc. OidcStrategy is inert
    // unless oidc is configured, so registering it always is safe (stackless deployments stay api-key).
    Binding.bind('platform.auth.strategy.api-key')
      .toClass(ApiKeyStrategy)
      .tag({[CoreTags.EXTENSION_FOR]: AUTH_STRATEGIES_EXTENSION_POINT})
      .tag({
        extensionType: AUTH_STRATEGY_EXTENSION_TYPE,
        name: 'api-key',
        version: '1.0.0',
      })
      .inScope(BindingScope.SINGLETON),
    Binding.bind('platform.auth.strategy.oidc')
      .toClass(OidcStrategy)
      .tag({[CoreTags.EXTENSION_FOR]: AUTH_STRATEGIES_EXTENSION_POINT})
      .tag({
        extensionType: AUTH_STRATEGY_EXTENSION_TYPE,
        name: 'oidc',
        version: '1.0.0',
      })
      .inScope(BindingScope.SINGLETON),
  ];
}
