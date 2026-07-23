// registerPlatformRestSequence — mounts the platform REST sequence onto a RestApplication root:
//   1. the ordered middleware (correlation → authentication);
//   2. an `orderedGroups` OVERRIDE positioning the platform stages BEFORE `findRoute` — LB4's default
//      runs `authentication` AFTER routing (it keys off route metadata), but the platform sequence
//      authorizes before routing so an unknown path returns 401, not 404, and no schema leaks
//      (sequence-implementation.md "authorize-before-validate");
//   3. the single error exit (PlatformReject over the default REJECT sequence action).
// Slice 1 mounts the two slots the public-health surface needs; tenant-resolution / rate-limit / the
// interceptor stack layer in with the first real controller.
import {createBindingFromClass} from '@loopback/core';
import {type RestApplication, RestBindings, RestMiddlewareGroups, RestTags} from '@loopback/rest';
import {PlatformSequenceGroups} from './sequence-groups.js';
import {CorrelationMiddleware} from './correlation.middleware.js';
import {FailClosedAuthenticationMiddleware} from './authentication.middleware.js';
import {PlatformReject} from './platform-reject.js';

// The full middleware-chain order (outermost→innermost). Extends LB4's default by inserting the
// platform pre-routing stages between the generic `middleware` group and `findRoute`.
const PLATFORM_ORDERED_GROUPS: readonly string[] = [
  RestMiddlewareGroups.SEND_RESPONSE, // outermost: catches downstream result/error → writes the response
  RestMiddlewareGroups.CORS,
  RestMiddlewareGroups.MIDDLEWARE,
  PlatformSequenceGroups.CORRELATION,
  PlatformSequenceGroups.AUTHENTICATION,
  // API_SPEC runs AFTER authentication (LB4's default puts it right behind CORS): /openapi.json and
  // /explorer expose the full route/schema surface — the exact leak "authorize-before-validate"
  // exists to prevent — so the built-in spec endpoints authenticate like any route. Dev opts them
  // back into anonymous serving via REST_PUBLIC_PATHS.
  RestMiddlewareGroups.API_SPEC,
  RestMiddlewareGroups.FIND_ROUTE,
  RestMiddlewareGroups.PARSE_PARAMS,
  RestMiddlewareGroups.INVOKE_METHOD,
];

export function registerPlatformRestSequence(app: RestApplication): void {
  app.add(createBindingFromClass(CorrelationMiddleware));
  app.add(createBindingFromClass(FailClosedAuthenticationMiddleware));
  // Override the middleware-chain order so the platform stages run before `findRoute`.
  app.configure(RestBindings.SEQUENCE).to({
    chain: RestTags.REST_MIDDLEWARE_CHAIN,
    orderedGroups: [...PLATFORM_ORDERED_GROUPS],
  });
  // Override the default Reject action so every error normalizes to `{ error: PlatformError }`.
  app.bind(RestBindings.SequenceActions.REJECT).toProvider(PlatformReject);
}
