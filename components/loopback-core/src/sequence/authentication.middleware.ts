// FailClosedAuthenticationMiddleware — the `authentication` slot (sequence-implementation.md), which
// writes PlatformBindings.REQUEST_PRINCIPAL and runs BEFORE `findRoute`/`parseParams` (the
// "authorize-before-validate" law: an unauthenticated caller or unknown route never reaches routing
// or schema validation, so error shapes never leak the request contract and an unknown path returns
// 401, not 404).
//
// Non-public routes are delegated to the AuthStrategyRegistry (AUTH-3, @platform-internal/auth),
// resolved by BINDING KEY from the request context — loopback-core cannot import the auth component
// (it's the other way round). On success the PrincipalMapper (the sole writer) binds the principal.
// Fail-closed everywhere: no registry bound → 401; registry rejects → its `unauthorized` propagates.
import {inject, injectable, type Provider} from '@loopback/core';
import {asMiddleware, type Middleware, type MiddlewareContext, type Request} from '@loopback/rest';
import {type AuthenticatedIdentity, PlatformErrorException, type PrincipalMapper} from '@platform/contracts';
import {PlatformSequenceGroups} from './sequence-groups.js';
import {REST_PUBLIC_PATHS} from './rest-bindings.js';

/** Health/openapi routes that need no principal. Overridable via REST_PUBLIC_PATHS. */
export const DEFAULT_PUBLIC_PATHS: readonly string[] = ['/v1/healthz', '/openapi.json', '/explorer'];

// The `@platform-internal/auth` binding keys, referenced by string to avoid a layering cycle
// (auth → loopback-core, never the reverse). Mirror of AuthBindings.{STRATEGY_REGISTRY,PRINCIPAL_MAPPER}.
const STRATEGY_REGISTRY_KEY = 'platform.auth.strategy-registry';
const PRINCIPAL_MAPPER_KEY = 'platform.auth.principal-mapper';

/** Structural view of the AuthStrategyRegistry (loopback-core can't import the auth component). */
interface Authenticator {
  authenticate(request: Request): Promise<AuthenticatedIdentity>;
}

function unauthorized(): PlatformErrorException {
  // Generic body — no claim/schema/route detail (acceptance criterion: no leakage).
  return new PlatformErrorException({
    category: 'authorization',
    code: 'unauthorized',
    message: 'Authentication required.',
    issues: [],
    retryable: false,
    httpStatus: 401,
  });
}

// The AUTHENTICATION group is repositioned BEFORE `findRoute` by the platform `orderedGroups`
// (registerPlatformRestSequence) — overriding LB4's default, which runs it after routing.
@injectable(
  asMiddleware({
    group: PlatformSequenceGroups.AUTHENTICATION,
    upstreamGroups: [PlatformSequenceGroups.CORRELATION],
  }),
)
export class FailClosedAuthenticationMiddleware implements Provider<Middleware> {
  constructor(
    @inject(REST_PUBLIC_PATHS, {optional: true})
    private readonly publicPaths: readonly string[] = DEFAULT_PUBLIC_PATHS,
  ) {}

  value(): Middleware {
    return async (ctx: MiddlewareContext, next) => {
      const path = ctx.request.path;
      const isPublic = this.publicPaths.some(p => path === p || path.startsWith(`${p}/`));
      if (isPublic) return next();

      // Non-public: an auth strategy MUST establish a principal. Resolve the plane from the request
      // context (request-scoped mapper binds against THIS ctx).
      const registry = await ctx.get<Authenticator>(STRATEGY_REGISTRY_KEY, {optional: true});
      if (!registry) throw unauthorized(); // auth plane not wired → fail-closed
      const identity = await registry.authenticate(ctx.request); // throws unauthorized on bad/absent credential
      const mapper = await ctx.get<PrincipalMapper>(PRINCIPAL_MAPPER_KEY);
      mapper.bindPrincipal(identity); // the sole writer of platform.request.principal
      return next();
    };
  }
}
