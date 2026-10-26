// admin-api process entrypoint. Identical shape to every other main.ts: hand the shared bootstrap()
// this process's CompositionRoot. reflect-metadata is imported first by bootstrap's module.
//
// Auth comes from config: api.apiKeys seed the StaticApiKeyStore, and api.oidcIssuers (if any)
// activate the oidc strategy with a remote-JWKS JoseJwtVerifier. With neither set, every request
// fails closed with 401.
import {createRemoteJWKSet} from 'jose';
import {bootstrap} from '@hermes-one/loopback-core';
import {AuthConfig, JoseJwtVerifier, OidcIssuerConfig} from '@hermes-one/auth';
import type {ApiKeySeed} from '@hermes-one/auth';
import type {PrincipalId, Scope, TenantId} from '@hermes-one/contracts';
import type {HermesConfig} from '@hermes-one/config';
import {AdminApiRoot} from './root.js';

function adminRoot(cfg: HermesConfig): AdminApiRoot {
  const apiKeySeeds: ApiKeySeed[] = cfg.api.apiKeys.map(k => ({
    key: k.key,
    record: {
      keyId: k.keyId,
      tenantId: k.tenantId as TenantId,
      principalId: k.principalId as PrincipalId,
      scopes: k.scopes as Scope[],
      status: 'active',
      expiresAt: null,
    },
  }));
  const issuers = cfg.api.oidcIssuers.map(i => ({
    config: OidcIssuerConfig.parse({
      issuer: i.issuer,
      audience: i.audience,
      jwksRef: i.jwksUri,
      ...(i.tenantClaim ? {tenantClaim: i.tenantClaim} : {}),
      ...(i.rolesClaim ? {rolesClaim: i.rolesClaim} : {}),
    }),
    jwks: createRemoteJWKSet(new URL(i.jwksUri)),
  }));
  return new AdminApiRoot(cfg, {
    apiKeySeeds,
    authConfig: AuthConfig.parse({
      apiKey: {},
      ...(issuers.length ? {oidc: {issuers: issuers.map(i => i.config)}} : {}),
    }),
    ...(issuers.length ? {jwtVerifier: new JoseJwtVerifier(issuers)} : {}),
  });
}

void bootstrap(adminRoot);
