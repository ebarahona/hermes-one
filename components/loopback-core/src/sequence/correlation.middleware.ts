// CorrelationMiddleware — the first platform slot (sequence-implementation.md §"Slot assignment",
// group `correlation`). Honors an inbound `x-correlation-id`, else mints one; binds it as
// PlatformBindings.CORRELATION_ID (request scope) for downstream stages; echoes it on the response as
// `X-Correlation-Id`. Because this runs first, EVERY response — including a 401 from the reject
// action — carries the header (the "Correlation-always" law).
import {randomUUID} from 'node:crypto';
import {injectable, type Provider} from '@loopback/core';
import {asMiddleware, type Middleware, type MiddlewareContext} from '@loopback/rest';
import {PlatformBindings} from '../bindings.js';
import {PlatformSequenceGroups} from './sequence-groups.js';

/** The request object carries the resolved id so the reject action (HandlerContext-only) can echo it. */
export const CORRELATION_ID_REQUEST_KEY = 'hermesCorrelationId';

// Global positioning is set by the platform `orderedGroups` (registerPlatformRestSequence); the only
// local edge asserted here is correlation → authentication (so a 401 already carries the header).
@injectable(
  asMiddleware({
    group: PlatformSequenceGroups.CORRELATION,
    downstreamGroups: [PlatformSequenceGroups.AUTHENTICATION],
  }),
)
export class CorrelationMiddleware implements Provider<Middleware> {
  value(): Middleware {
    return async (ctx: MiddlewareContext, next) => {
      const inbound = ctx.request.headers['x-correlation-id'];
      const correlationId = (Array.isArray(inbound) ? inbound[0] : inbound) || randomUUID();
      ctx.bind(PlatformBindings.CORRELATION_ID.key).to(correlationId);
      // Stash on the raw request so the single error exit (PlatformReject) can read it without a
      // per-request Context resolve.
      (ctx.request as unknown as Record<string, unknown>)[CORRELATION_ID_REQUEST_KEY] = correlationId;
      ctx.response.setHeader('X-Correlation-Id', correlationId);
      return next();
    };
  }
}
