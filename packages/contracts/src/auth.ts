// @hermes-one/contracts — src/auth.ts
// The container-free authentication facts + verifier ports.
// SPLIT per the edge-authn design (docs/design/001-edge-authn-design.md): the zod facts + the ports
// that do NOT reference `@loopback/rest`'s `Request` live here (contracts stay container-free, ADR-017); `AuthStrategy` + `toUserProfile`
// (which reference `Request`/`UserProfile`) live in `@hermes-one/auth`.
import {z} from 'zod';
import {Principal, PrincipalKind, Scope} from './tenant.js';
import {TenantId, PrincipalId, IsoTimestamp} from './substrate.js'; // substrate

/* ----------------------------- Auth facts ------------------------------ */

/** The concrete method that authenticated the caller. */
export const AuthMethod = z.enum([
  'oidc',
  'oauth2',
  'api-key',
  'signed-webhook',
  'service-identity',
]);
export type AuthMethod = z.infer<typeof AuthMethod>;

/**
 * Authentication strength (authentication-strength levels, including step-up).
 * Ordered weakest→strongest; policy pre-gates compare against a required minimum.
 */
export const AuthStrength = z.enum([
  'anonymous', // never authenticated (rejected before mapping — present for completeness)
  'single', // single factor (password/OIDC without amr=mfa, plain bearer)
  'mfa', // multi-factor at login (amr includes mfa/otp/hwk)
  'step-up', // fresh re-authentication for a sensitive action
  'api-key', // long-lived service credential (non-interactive)
  'workload', // platform-issued workload/mTLS identity (non-interactive, strong)
]);
export type AuthStrength = z.infer<typeof AuthStrength>;

/** Device/session metadata for human sessions. Serializable, PII-light. */
export const SessionMeta = z.object({
  sessionId: z.string().min(1).optional(),
  deviceId: z.string().max(200).optional(),
  ip: z.string().max(64).optional(),
  userAgent: z.string().max(512).optional(),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

/**
 * What a strategy returns on success. The PrincipalMapper reduces this to a `Principal`
 * and binds platform.request.principal; the auth-metadata is attached to the request for
 * downstream policy (step-up) and audit.
 */
export const AuthenticatedIdentity = z.object({
  principal: Principal, // fully-formed, tenant-scoped
  method: AuthMethod,
  authStrength: AuthStrength,
  /** Absolute session/credential expiry; null for stateless single-request credentials. */
  sessionExpiry: IsoTimestamp.nullable(),
  session: SessionMeta.optional(),
  /** Raw authenticated-at instant; used by step-up freshness checks. */
  authenticatedAt: IsoTimestamp,
});
export type AuthenticatedIdentity = z.infer<typeof AuthenticatedIdentity>;

/* --------------------------- PrincipalMapper ---------------------------- */

/** Single writer of platform.request.principal. Strategies never bind it directly. */
export interface PrincipalMapper {
  /** Bind Principal + attach auth-metadata to the request context; returns the bound principal. */
  bindPrincipal(id: AuthenticatedIdentity): Principal;
  /** Pure claim → Principal projection (testable in isolation). */
  fromClaims(input: {
    subject: PrincipalId;
    tenantId: TenantId;
    kind: PrincipalKind;
    roles: string[];
    scopes: Scope[];
    attributes?: Record<string, string | number | boolean | null>;
  }): Principal;
}

/* ---------------------------- Verifier ports ---------------------------- */

/** OIDC/OAuth2 token verification against a cached JWKS (issuer/audience pinned per tenant). */
export interface JwtVerifier {
  verify(
    token: string,
    opts: {issuer: string; audience: string},
  ): Promise<VerifiedClaims>;
}
export const VerifiedClaims = z.object({
  sub: z.string().min(1),
  /** Tenant claim; claim name is configurable per issuer (see AuthConfig). */
  tid: z.string().min(1).optional(),
  roles: z.array(z.string()).default([]),
  scope: z.string().optional(), // space-delimited OAuth2 scopes
  amr: z.array(z.string()).default([]), // auth methods refs → AuthStrength
  exp: z.number().int(),
  iat: z.number().int(),
});
export type VerifiedClaims = z.infer<typeof VerifiedClaims>;

/** API-key lookup by hashed key; the store never returns the plaintext key. */
export interface ApiKeyStore {
  /** Constant-time hashed lookup; undefined ⇒ unknown/revoked key. */
  resolve(presentedKey: string): Promise<ApiKeyRecord | undefined>;
}
export const ApiKeyRecord = z.object({
  keyId: z.string().min(1),
  tenantId: TenantId,
  principalId: PrincipalId,
  scopes: z.array(Scope),
  status: z.enum(['active', 'revoked']),
  expiresAt: IsoTimestamp.nullable(),
});
export type ApiKeyRecord = z.infer<typeof ApiKeyRecord>;

/** HMAC signature verifier for inbound webhooks (raw-body + timestamp). */
export interface WebhookSignatureVerifier {
  verify(input: {
    providerId: string;
    rawBody: Buffer;
    timestamp: string;
    signature: string;
    secretRef: string; // secret:// pointer (135)
  }): Promise<boolean>; // constant-time compare
}

/** mTLS client-cert / SPIFFE / cloud workload-OIDC verifier. */
export interface ServiceIdentityVerifier {
  verify(request: unknown): Promise<WorkloadClaims>; // contract: (request: Request) — kept container-free here
}
export const WorkloadClaims = z.object({
  /** SPIFFE ID or cloud service-account subject. */
  workloadId: z.string().min(1),
  allowedTenants: z.array(TenantId), // '*' expands to platform-scope service principals
  scopes: z.array(Scope),
});
export type WorkloadClaims = z.infer<typeof WorkloadClaims>;

/** Redis-backed single-use nonce guard for stateless credentials. */
export interface NonceStore {
  /** true if freshly reserved; false if already seen (replay). */
  reserve(key: string, ttlSeconds: number): Promise<boolean>;
}

/** Redis-backed human session store. */
export interface SessionStore {
  get(sid: string): Promise<StoredSession | undefined>;
  put(session: StoredSession): Promise<void>;
  revoke(sid: string): Promise<void>;
}
export const StoredSession = z.object({
  sid: z.string().min(1),
  principalId: PrincipalId,
  tenantId: TenantId,
  roles: z.array(z.string()),
  authStrength: AuthStrength,
  session: SessionMeta,
  createdAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
});
export type StoredSession = z.infer<typeof StoredSession>;
