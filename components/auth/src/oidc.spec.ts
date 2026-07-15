// Unit tests for the OIDC bearer path (hermetic — a locally-generated RS256 key + a local JWKS, no
// network, no DI container). Covers JwtVerifier signature/issuer/audience/expiry enforcement and the
// OidcStrategy claim→Principal minting (with a fake RoleRegistry for scope resolution).
import {describe, expect, it} from 'vitest';
import {SignJWT, exportJWK, generateKeyPair, createLocalJWKSet} from 'jose';
import type {Request} from '@loopback/rest';
import type {RoleRegistry, Scope, TenantId} from '@platform/contracts';
import {JoseJwtVerifier, type ResolvedIssuer} from './jwt-verifier.js';
import {OidcStrategy} from './oidc.strategy.js';
import {AuthConfig, OidcIssuerConfig} from './contracts.js';

const ISSUER = 'https://login.test/';
const AUDIENCE = 'platform-admin';
const TID_CLAIM = 'https://platform/tenant_id';
const ROLES_CLAIM = 'https://platform/roles';

const issuerConfig = OidcIssuerConfig.parse({
  issuer: ISSUER,
  audience: AUDIENCE,
  jwksRef: 'secret://oidc/test/jwks',
  tenantClaim: TID_CLAIM,
  rolesClaim: ROLES_CLAIM,
});

// A shared keypair + local JWKS + signer for the suite.
const {publicKey, privateKey} = await generateKeyPair('RS256');
const jwks = createLocalJWKSet({keys: [{...(await exportJWK(publicKey)), alg: 'RS256', kid: 'test'}]});
const verifier = new JoseJwtVerifier([{config: issuerConfig, jwks} satisfies ResolvedIssuer]);

async function sign(claims: Record<string, unknown>, opts: {aud?: string; expInPast?: boolean} = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({alg: 'RS256', kid: 'test'})
    .setIssuer(ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setSubject('auth0|abc123')
    .setIssuedAt(now)
    .setExpirationTime(opts.expInPast ? now - 60 : now + 3600)
    .sign(privateKey);
}

const bearer = (token: string): Request => ({headers: {authorization: `Bearer ${token}`}}) as unknown as Request;

describe('JoseJwtVerifier', () => {
  it('verifies a well-formed token and maps the configured claim names', async () => {
    const token = await sign({[TID_CLAIM]: 'tnt_oidc', [ROLES_CLAIM]: ['tenant-admin'], amr: ['pwd', 'otp']});
    const claims = await verifier.verify(token, {issuer: ISSUER, audience: AUDIENCE});
    expect(claims.tid).toBe('tnt_oidc');
    expect(claims.roles).toEqual(['tenant-admin']);
    expect(claims.amr).toEqual(['pwd', 'otp']);
  });

  it('rejects a wrong audience and an expired token', async () => {
    await expect(
      verifier.verify(await sign({[TID_CLAIM]: 'tnt_oidc'}, {aud: 'someone-else'}), {issuer: ISSUER, audience: AUDIENCE}),
    ).rejects.toBeTruthy();
    await expect(
      verifier.verify(await sign({[TID_CLAIM]: 'tnt_oidc'}, {expInPast: true}), {issuer: ISSUER, audience: AUDIENCE}),
    ).rejects.toBeTruthy();
  });
});

describe('OidcStrategy', () => {
  const roles = {
    resolveScopes: async (_t: TenantId, names: readonly string[]) =>
      (names.includes('tenant-admin') ? ['tenant.role.read'] : []) as Scope[],
  } as unknown as RoleRegistry;
  const config = AuthConfig.parse({apiKey: {}, oidc: {issuers: [issuerConfig]}});
  const strat = new OidcStrategy(verifier, config, roles);

  it('is inert without a verifier/config, and applies() only to Bearer tokens', () => {
    expect(new OidcStrategy(undefined, config, roles).applies(bearer('x'))).toBe(false); // no verifier
    expect(strat.applies({headers: {}} as unknown as Request)).toBe(false); // no bearer
    expect(strat.applies(bearer('x'))).toBe(true);
  });

  it('mints a user Principal with per-request resolved scopes and amr-derived strength', async () => {
    const token = await sign({[TID_CLAIM]: 'tnt_oidc', [ROLES_CLAIM]: ['tenant-admin'], amr: ['pwd', 'otp']});
    const id = await strat.authenticate(bearer(token));
    expect(id?.method).toBe('oidc');
    expect(id?.authStrength).toBe('mfa'); // amr includes otp
    expect(id?.principal.kind).toBe('user');
    expect(id?.principal.tenantId).toBe('tnt_oidc');
    expect(id?.principal.roles).toEqual(['tenant-admin']);
    expect(id?.principal.scopes).toEqual(['tenant.role.read']); // from the fake RoleRegistry
  });

  it('throws unauthorized on a bad token', async () => {
    await expect(strat.authenticate(bearer('not.a.jwt'))).rejects.toBeTruthy();
  });
});
