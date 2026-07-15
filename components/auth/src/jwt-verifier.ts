// JoseJwtVerifier — the OIDC/OAuth2 JwtVerifier port realized with `jose`. Verifies a bearer token's
// signature against the issuer's JWKS with `iss`/`aud`/`exp` pinned, then maps the (per-issuer,
// configurable) tenant/roles claim names into the canonical VerifiedClaims (authentication-strategies.md).
//
// The JWKS RESOLVER is injected per issuer (`ResolvedIssuer.jwks`): `createRemoteJWKSet(new URL(uri))`
// in prod (cached by jose), or `createLocalJWKSet(jwks)` in tests — so no network is needed to test.
import {jwtVerify, type JWTVerifyGetKey} from 'jose';
import {type JwtVerifier, VerifiedClaims} from '@platform/contracts';
import type {OidcIssuerConfig} from './contracts.js';

/** An issuer's verification config paired with its resolved JWKS getter. */
export interface ResolvedIssuer {
  readonly config: OidcIssuerConfig;
  readonly jwks: JWTVerifyGetKey;
}

export class JoseJwtVerifier implements JwtVerifier {
  constructor(private readonly issuers: readonly ResolvedIssuer[]) {}

  async verify(token: string, opts: {issuer: string; audience: string}): Promise<VerifiedClaims> {
    const match = this.issuers.find(
      i => i.config.issuer === opts.issuer && i.config.audience === opts.audience,
    );
    if (!match) throw new Error(`no configured OIDC issuer for ${opts.issuer}`);

    // jose enforces signature + iss + aud + exp; throws on any failure.
    const {payload} = await jwtVerify(token, match.jwks, {
      issuer: opts.issuer,
      audience: opts.audience,
    });

    const c = match.config;
    const tid = payload[c.tenantClaim];
    const roles = payload[c.rolesClaim];
    return VerifiedClaims.parse({
      sub: payload.sub,
      tid: typeof tid === 'string' ? tid : undefined,
      roles: Array.isArray(roles) ? roles : [],
      scope: typeof payload.scope === 'string' ? payload.scope : undefined,
      amr: Array.isArray(payload.amr) ? payload.amr : [],
      exp: payload.exp,
      iat: payload.iat,
    });
  }
}
