// Coarse edge authorization (ADR-019): the "can this principal call this route at all" scope gate.
// The admin-api extraction: RouteAuthorization.requiredScope → `edge-authorization` returns
// 403 `forbidden_scope` (NOT 401) when the authenticated principal lacks the scope. The first controller enforces
// this inline at the controller (via assertScope); the middleware-based route→scope gate that runs
// before invokeMethod is a later refinement (flagged) — this helper is the reusable primitive either
// way. Wildcard matching is shared with the capability plane's tool-visibility gate (scopeSatisfies).
import {
  type Principal,
  PlatformErrorException,
  type Scope,
} from '@hermes-one/contracts';
import {scopeSatisfies} from '@hermes-one/capability-contract';

/** The canonical 403 for a missing scope. Generic body — no scope/route detail leaked. */
export function forbiddenScopeError(): PlatformErrorException {
  return new PlatformErrorException({
    category: 'authorization',
    code: 'forbidden_scope',
    message: 'Insufficient scope.',
    issues: [],
    retryable: false,
    httpStatus: 403,
  });
}

/** Throw 403 `forbidden_scope` unless the principal's scopes satisfy `required` (wildcards honored). */
export function assertScope(principal: Principal, required: Scope): void {
  if (!scopeSatisfies(principal.scopes, required)) throw forbiddenScopeError();
}
