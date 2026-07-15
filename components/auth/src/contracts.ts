// @platform-internal/auth — src/contracts.ts
// The container-COUPLED half of authentication-strategies.md §"TypeScript Interfaces": AuthStrategy
// (references @loopback/rest's Request) + the component's AuthConfig. The container-free facts/ports
// (AuthenticatedIdentity, ApiKeyStore, PrincipalMapper, …) live in @platform/contracts/src/auth.ts
// and are re-exported here for one import site (design 001).
//
// Spec delta (flagged): the spec's AuthStrategy `extends PlatformExtension` (from
// `@platform/agent-runtime`, extension-point-registry.md) — but that package/type does NOT exist in
// this repo; the real extension idiom here is LB4's `CoreTags.EXTENSION_FOR` tag (as the capability
// registry uses). So AuthStrategy stands alone (name/applies/authenticate) and is discovered via the
// EXTENSION_FOR tag. Recorded in Open Questions / the deferral ledger.
import {z} from 'zod';
import type {Request} from '@loopback/rest';
import {type AuthenticatedIdentity, type AuthMethod, PlatformErrorException} from '@platform/contracts';

/**
 * Every authentication method is a DI provider implementing this contract, discovered at the
 * `platform.extensions.authStrategies` extension point. `authenticate` returns undefined ONLY when
 * the strategy does not apply (wrong credential shape); a present-but-invalid credential MUST throw
 * `unauthorized` (fail-closed).
 */
export interface AuthStrategy {
  /** LB4 strategy name, also the AuthMethod value. */
  readonly name: AuthMethod;
  /** True if this strategy recognises the request's credential shape (cheap, no verification). */
  applies(request: Request): boolean;
  /** Verify + build identity, or throw PlatformError(unauthorized). undefined ⇒ not applicable. */
  authenticate(request: Request): Promise<AuthenticatedIdentity | undefined>;
}

/**
 * Minimal AuthConfig for AUTH-3 Slice 2 (api-key only). The full shape (strategyOrder, oidc issuers,
 * session, stepUp — design 001 §Configuration) lands with the oidc strategy (Slice 4). The spec's
 * AuthConfig is JSON-Schema-only; this is the zod source it generates from (contracts are Zod-first).
 */
export const AuthConfig = z.object({
  apiKey: z.object({
    header: z.string().min(1).default('x-api-key'),
    hashAlgo: z.enum(['sha-256', 'sha-512']).default('sha-256'),
  }),
});
export type AuthConfig = z.infer<typeof AuthConfig>;

/** Build the canonical `unauthorized` PlatformError (generic body — no leakage). `reason` is for logs. */
export function unauthorizedError(_reason: string): PlatformErrorException {
  return new PlatformErrorException({
    category: 'authorization',
    code: 'unauthorized',
    message: 'Authentication required.',
    issues: [],
    retryable: false,
    httpStatus: 401,
  });
}
