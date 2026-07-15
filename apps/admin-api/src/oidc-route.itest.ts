// Live-PG integration for the OIDC bearer path (Slice 4): boots admin-api WITH Persistence + an
// oidc-configured JoseJwtVerifier (local RS256 key, local JWKS — no network) and drives /v1/whoami
// with a real signed bearer JWT. Proves the full human path end-to-end: JWT verified → user Principal
// minted with tenant from the tenant claim and SCOPES RESOLVED per-request via the RLS-enforced
// RoleRegistry (the platform `customer` role's scopes, migration 0029). Needs the compose PG stack.
import 'reflect-metadata';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {SignJWT, exportJWK, generateKeyPair, createLocalJWKSet} from 'jose';
import {loadConfig} from '@platform-internal/config';
import type {PlatformRestApplication} from '@platform-internal/loopback-core';
import {AuthConfig, JoseJwtVerifier, OidcIssuerConfig, type ResolvedIssuer} from '@platform-internal/auth';
import {AdminApiRoot} from './root.js';

const ISSUER = 'https://login.itest/';
const AUDIENCE = 'platform-admin';
const TID_CLAIM = 'https://platform/tenant_id';
const ROLES_CLAIM = 'https://platform/roles';
const TENANT = 'tnt_oidc_itest';

const issuerConfig = OidcIssuerConfig.parse({
  issuer: ISSUER,
  audience: AUDIENCE,
  jwksRef: 'secret://oidc/itest/jwks',
  tenantClaim: TID_CLAIM,
  rolesClaim: ROLES_CLAIM,
});

const {publicKey, privateKey} = await generateKeyPair('RS256');
const jwks = createLocalJWKSet({keys: [{...(await exportJWK(publicKey)), alg: 'RS256', kid: 'itest'}]});

async function signAdminToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({[TID_CLAIM]: TENANT, [ROLES_CLAIM]: ['customer'], amr: ['pwd']})
    .setProtectedHeader({alg: 'RS256', kid: 'itest'})
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject('auth0|admin-itest')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

let app: PlatformRestApplication;
let base: string;

beforeAll(async () => {
  const loaded = loadConfig();
  const cfg = {...loaded, api: {...loaded.api, port: 0}};
  const root = new AdminApiRoot(cfg, {
    authConfig: AuthConfig.parse({apiKey: {}, oidc: {issuers: [issuerConfig]}}),
    jwtVerifier: new JoseJwtVerifier([{config: issuerConfig, jwks} satisfies ResolvedIssuer]),
  });
  app = root.createApp();
  root.bindPorts(app);
  root.registerComponents(app);
  await app.start();
  base = app.restServer.url!;
});

afterAll(async () => {
  await app?.stop();
});

describe('OIDC bearer path (live)', () => {
  it('verifies a bearer JWT → user principal with role-resolved scopes', async () => {
    const token = await signAdminToken();
    const res = await fetch(`${base}/v1/whoami`, {headers: {authorization: `Bearer ${token}`}});
    expect(res.status).toBe(200);
    const me = (await res.json()) as {principalId: string; tenantId: string; kind: string; scopes: string[]};
    expect(me.kind).toBe('user');
    expect(me.tenantId).toBe(TENANT);
    expect(me.principalId).toBe('prn_auth0adminitest'); // derived from sub (JIT)
    // Scopes resolved from the platform `customer` role (migration 0029), per-request via RLS registry.
    expect(me.scopes).toEqual(
      expect.arrayContaining(['appointment.slot.read', 'appointment.booking.create']),
    );
  });

  it('rejects a malformed/forged bearer token → 401', async () => {
    const res = await fetch(`${base}/v1/whoami`, {headers: {authorization: 'Bearer not.a.jwt'}});
    expect(res.status).toBe(401);
    expect(((await res.json()) as {error?: {code?: string}}).error?.code).toBe('unauthorized');
  });
});
