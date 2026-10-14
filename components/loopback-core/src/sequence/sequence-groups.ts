// The platform REST sequence vocabulary — one shared group namespace for both mechanisms the
// sequence decomposes into:
//   1. REST middleware — @injectable(asMiddleware({group, upstreamGroups, downstreamGroups})),
//      run around the built-in findRoute → parseParams → invokeMethod → sendResponse actions.
//   2. Global interceptors — @injectable(asGlobalInterceptor(group)), wrapping ONLY the controller
//      method invocation.
export const PlatformSequenceGroups = {
  CORRELATION: 'correlation',
  TRACING: 'tracing',
  TENANT: 'tenant-resolution',
  AUTHENTICATION: 'authentication',
  AUTHORIZATION: 'edge-authorization',
  RATE_LIMIT: 'rate-limit',
  LOCALE_CHANNEL: 'locale-channel',
  IDEMPOTENCY: 'idempotency',
  TENANT_TX: 'tenant-tx',
  METERING: 'metering',
  AUDIT: 'audit',
} as const;

// The platform stages, in run order, that must sit BEFORE routing (`findRoute`) — the
// "authorize-before-validate" law: an unauthenticated/unauthorized caller (or an unknown route)
// never reaches route matching or schema validation, so error shapes never leak the request contract
// and an unknown path returns 401, not 404. LB4's built-in default instead runs `authentication`
// AFTER `findRoute` (it keys off route metadata); the platform overrides `orderedGroups` to reposition
// these ahead of it (see registerPlatformRestSequence). Slice 1 mounts CORRELATION + AUTHENTICATION;
// the remaining groups layer in with tenant-resolution / the first real controller.
export const PLATFORM_PRE_ROUTING_GROUPS: readonly string[] = [
  PlatformSequenceGroups.CORRELATION,
  PlatformSequenceGroups.TRACING,
  PlatformSequenceGroups.TENANT,
  PlatformSequenceGroups.AUTHENTICATION,
  PlatformSequenceGroups.AUTHORIZATION,
  PlatformSequenceGroups.RATE_LIMIT,
  PlatformSequenceGroups.LOCALE_CHANNEL,
];
