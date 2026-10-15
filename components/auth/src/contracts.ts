// @platform-internal/auth — src/contracts.ts
// The container-COUPLED half of the auth contracts: AuthStrategy
// (references @loopback/rest's Request) + the component's AuthConfig. The container-free facts/ports
// (AuthenticatedIdentity, ApiKeyStore, PrincipalMapper, …) live in @platform/contracts/src/auth.ts
// and are re-exported here for one import site (design 001).
//
// Design note (flagged): an AuthStrategy could `extends PlatformExtension` (from
// `@platform/agent-runtime`) — but that package/type does NOT exist in
// this repo; the real extension idiom here is LB4's `CoreTags.EXTENSION_FOR` tag (as the capability
// registry uses). So AuthStrategy stands alone (name/applies/authenticate) and is discovered via the
// EXTENSION_FOR tag. Recorded in the deferral ledger.
import {z} from 'zod';
import type {Request} from '@loopback/rest';
import {
  type AuthenticatedIdentity,
  type AuthMethod,
  PlatformErrorException,
} from '@platform/contracts';

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

/** One OIDC issuer's verification + claim-mapping config (design 001 Configuration `oidc.issuers[]`). */
export const OidcIssuerConfig = z.object({
  issuer: z.string().min(1), // expected `iss`
  audience: z.string().min(1), // expected `aud`
  jwksRef: z.string().min(1), // secret:// pointer to the JWKS (URL or key set)
  tenantClaim: z.string().min(1).default('tid'), // token claim carrying the tenant id → VerifiedClaims.tid
  rolesClaim: z.string().min(1).default('roles'), // token claim carrying the role names → VerifiedClaims.roles
  jwksCacheTtlSeconds: z.number().int().positive().default(900),
});
export type OidcIssuerConfig = z.infer<typeof OidcIssuerConfig>;

/**
 * AuthConfig. Slice 2 shipped `apiKey`; Slice 4 adds the optional `oidc` block. The `oidc` strategy is
 * INERT when the block is absent (no JWKS/issuers) — so a stackless deployment stays api-key-only. The
 * remaining fields (strategyOrder, session, stepUp — design 001 Configuration) land with the
 * session/cookie branch. The AuthConfig design is JSON-Schema-only; this is the Zod source (Zod-first).
 */
export const AuthConfig = z.object({
  apiKey: z.object({
    header: z.string().min(1).default('x-api-key'),
    hashAlgo: z.enum(['sha-256', 'sha-512']).default('sha-256'),
  }),
  oidc: z
    .object({
      issuers: z.array(OidcIssuerConfig).min(1),
    })
    .optional(),
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
