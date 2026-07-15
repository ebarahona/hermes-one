// FailClosedAuthenticationMiddleware — the `authentication` slot (sequence-implementation.md), which
// writes PlatformBindings.REQUEST_PRINCIPAL and runs BEFORE `parseParams` (the "Authorize-before-
// validate" law: an unauthenticated caller never reaches schema validation, so error shapes never
// leak the request contract).
//
// Slice 1 posture: DENY BY DEFAULT. No auth strategies exist yet (AUTH-3, next slice), so every route
// that is not on the public allowlist is rejected `unauthorized`. When the AuthStrategyRegistry lands,
// this middleware delegates to it for non-public routes and binds the returned principal via the
// PrincipalMapper — the deny-by-default fallthrough stays (fail-closed when no strategy applies).
import {inject, injectable, type Provider} from '@loopback/core';
import {asMiddleware, type Middleware, type MiddlewareContext} from '@loopback/rest';
import {PlatformErrorException} from '@platform/contracts';
import {PlatformSequenceGroups} from './sequence-groups.js';
import {REST_PUBLIC_PATHS} from './rest-bindings.js';

/** Health/openapi routes that need no principal. Overridable via REST_PUBLIC_PATHS. */
export const DEFAULT_PUBLIC_PATHS: readonly string[] = ['/v1/healthz', '/openapi.json', '/explorer'];

function unauthorized(): PlatformErrorException {
  // Generic body — no claim/schema/route detail (acceptance criterion #: no leakage).
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
      if (!isPublic) throw unauthorized(); // no strategy yet → fail-closed
      return next();
    };
  }
}
