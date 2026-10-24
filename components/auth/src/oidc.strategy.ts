// OidcStrategy — the human admin bearer-JWT path (OIDC human login,
// bearer id_token branch). applies() when a Bearer token is present AND oidc is configured; otherwise
// INERT (so an api-key-only / stackless deployment is unaffected). authenticate() verifies the token
// via the JwtVerifier (JWKS, iss/aud/exp pinned), then mints a `user` Principal: tenant from the
// tenant claim, roles from the roles claim, SCOPES RESOLVED PER REQUEST via RoleRegistry.resolveScopes
// (never cached — a role edit lands on the next request), authStrength derived honestly from `amr`.
//
// Deferred (this is the bearer branch only; flagged): the Redis SessionStore + cookie/login branch
// (SessionStore.get/put) and step-up. Flagged: the principal id is derived from `sub`
// (`prn_<sub>`) — real user resolution against tenant.users is later work.
import {inject, injectable} from '@loopback/core';
import {decodeJwt} from 'jose';
import type {Request} from '@loopback/rest';
import {
  type AuthenticatedIdentity,
  AuthenticatedIdentity as AuthenticatedIdentitySchema,
  type AuthStrength,
  type JwtVerifier,
  Principal,
  type RoleRegistry,
  type TenantId,
} from '@hermes-one/contracts';
import {PlatformBindings} from '@hermes-one/loopback-core';
import type {AuthStrategy, AuthConfig} from './contracts.js';
import {unauthorizedError} from './contracts.js';
import {AuthBindings} from './auth.bindings.js';

/** amr → AuthStrength: any multi-factor ref ⇒ mfa, else single. */
const MFA_REFS = new Set(['mfa', 'otp', 'hwk', 'totp', 'sms']);
function strengthFromAmr(amr: readonly string[]): AuthStrength {
  return amr.some(a => MFA_REFS.has(a)) ? 'mfa' : 'single';
}

@injectable()
export class OidcStrategy implements AuthStrategy {
  readonly name = 'oidc' as const;

  constructor(
    @inject(AuthBindings.JWT_VERIFIER, {optional: true})
    private readonly verifier?: JwtVerifier,
    @inject(AuthBindings.CONFIG, {optional: true})
    private readonly config?: AuthConfig,
    @inject(PlatformBindings.ROLE_REGISTRY, {optional: true})
    private readonly roles?: RoleRegistry,
  ) {}

  private bearer(request: Request): string | undefined {
    const raw = request.headers.authorization;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value?.toLowerCase().startsWith('bearer ')) return undefined;
    return value.slice('bearer '.length).trim() || undefined;
  }

  applies(request: Request): boolean {
    // Inert unless oidc is configured (no JWKS/issuers ⇒ never claims a request).
    if (!this.verifier || !this.config?.oidc) return false;
    return this.bearer(request) !== undefined;
  }

  async authenticate(
    request: Request,
  ): Promise<AuthenticatedIdentity | undefined> {
    const token = this.bearer(request);
    if (!token || !this.verifier || !this.config?.oidc) return undefined;

    // Peek the (unverified) issuer to pick its config; verification happens in verify().
    let iss: string | undefined;
    try {
      iss = decodeJwt(token).iss;
    } catch {
      throw unauthorizedError('oidc_malformed_token');
    }
    const issuer = this.config.oidc.issuers.find(i => i.issuer === iss);
    if (!issuer) throw unauthorizedError('oidc_unknown_issuer');
    if (!this.roles) throw unauthorizedError('oidc_role_registry_unavailable');

    let claims;
    try {
      claims = await this.verifier.verify(token, {
        issuer: issuer.issuer,
        audience: issuer.audience,
      });
    } catch {
      throw unauthorizedError('oidc_verify_failed'); // bad signature / aud / expired
    }
    if (!claims.tid) throw unauthorizedError('oidc_no_tenant_claim');

    const tenantId = claims.tid as TenantId;
    const scopes = await this.roles.resolveScopes(tenantId, claims.roles); // per-request, never cached
    const principal = Principal.parse({
      id: `prn_${claims.sub.replace(/[^a-z0-9]/gi, '')}`,
      tenantId,
      kind: 'user',
      roles: claims.roles,
      scopes,
      attributes: {},
    });

    return AuthenticatedIdentitySchema.parse({
      principal,
      method: 'oidc',
      authStrength: strengthFromAmr(claims.amr),
      sessionExpiry: new Date(claims.exp * 1000).toISOString(),
      authenticatedAt: new Date().toISOString(),
    });
  }
}
