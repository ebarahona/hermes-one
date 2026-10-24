// AuthStrategyRegistry — first strategy whose applies()
// matches; fail-closed if none. Discovered via the LB4 extension point.
import {extensionPoint, extensions, type Getter} from '@loopback/core';
import type {Request} from '@loopback/rest';
import type {AuthenticatedIdentity} from '@hermes-one/contracts';
import type {AuthStrategy} from './contracts.js';
import {unauthorizedError} from './contracts.js';

export const AUTH_STRATEGIES_EXTENSION_POINT =
  'platform.extensions.authStrategies';
export const AUTH_STRATEGY_EXTENSION_TYPE = 'auth.strategy'; // matches ^[a-z]+\.[a-z]+$

@extensionPoint(AUTH_STRATEGIES_EXTENSION_POINT)
export class AuthStrategyRegistry {
  // `@extensions()` alone (name inferred from @extensionPoint) is not used; the explicit name is the robust
  // form — the inferred variant discovered zero strategies in this wiring.
  constructor(
    @extensions(AUTH_STRATEGIES_EXTENSION_POINT)
    private readonly all: Getter<AuthStrategy[]>,
  ) {}

  /** First strategy whose `applies()` matches; fail-closed if none. */
  async authenticate(request: Request): Promise<AuthenticatedIdentity> {
    const strategies = await this.all();
    for (const s of strategies) {
      if (!s.applies(request)) continue;
      const identity = await s.authenticate(request); // throws unauthorized on bad credential
      if (identity) return identity;
    }
    throw unauthorizedError('no_applicable_auth_strategy'); // → PlatformError code 'unauthorized'
  }
}
