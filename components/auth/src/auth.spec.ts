// Unit tests for the AUTH-3 api-key plane (hermetic — no DI container, no HTTP). Covers the
// StaticApiKeyStore hashed lookup, the ApiKeyStrategy verify/mint + fail-closed paths, and the
// PrincipalMapper pure projection.
import {describe, expect, it} from 'vitest';
import type {Request} from '@loopback/rest';
import type {
  ApiKeyRecord,
  PrincipalId,
  Scope,
  TenantId,
} from '@platform/contracts';
import {PlatformErrorException} from '@platform/contracts';
import {StaticApiKeyStore} from './static-api-key-store.js';
import {ApiKeyStrategy} from './api-key.strategy.js';
import {DefaultPrincipalMapper} from './principal-mapper.js';
import {AuthConfig} from './contracts.js';

const rec = (over: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
  keyId: 'apk_1',
  tenantId: 'tnt_acme' as TenantId,
  principalId: 'prn_svc' as PrincipalId,
  scopes: ['tenant.role.read'] as Scope[],
  status: 'active',
  expiresAt: null,
  ...over,
});

const CONFIG = AuthConfig.parse({apiKey: {}});
const reqWith = (key?: string): Request =>
  ({
    headers: key === undefined ? {} : {'x-api-key': key},
  }) as unknown as Request;

describe('StaticApiKeyStore', () => {
  it('resolves a seeded key and returns undefined for unknown keys', async () => {
    const store = new StaticApiKeyStore([{key: 'secret-1', record: rec()}]);
    expect(await store.resolve('secret-1')).toMatchObject({
      keyId: 'apk_1',
      status: 'active',
    });
    expect(await store.resolve('wrong')).toBeUndefined();
  });
});

describe('ApiKeyStrategy', () => {
  const strat = (seed?: {key: string; record: ApiKeyRecord}) =>
    new ApiKeyStrategy(new StaticApiKeyStore(seed ? [seed] : []), CONFIG);

  it('applies() only when the configured header is present', () => {
    const s = strat();
    expect(s.applies(reqWith('k'))).toBe(true);
    expect(s.applies(reqWith())).toBe(false);
  });

  it('authenticates a valid key → a service principal with the key’s scopes', async () => {
    const s = strat({key: 'k1', record: rec()});
    const id = await s.authenticate(reqWith('k1'));
    expect(id?.method).toBe('api-key');
    expect(id?.authStrength).toBe('api-key');
    expect(id?.principal.kind).toBe('service');
    expect(id?.principal.id).toBe('prn_svc');
    expect(id?.principal.scopes).toEqual(['tenant.role.read']);
  });

  it('throws unauthorized for an unknown, revoked, or expired key', async () => {
    await expect(strat().authenticate(reqWith('nope'))).rejects.toBeInstanceOf(
      PlatformErrorException,
    );
    const revoked = strat({key: 'r', record: rec({status: 'revoked'})});
    await expect(revoked.authenticate(reqWith('r'))).rejects.toBeInstanceOf(
      PlatformErrorException,
    );
    const expired = strat({
      key: 'e',
      record: rec({
        expiresAt: '2000-01-01T00:00:00.000Z' as ApiKeyRecord['expiresAt'],
      }),
    });
    await expect(expired.authenticate(reqWith('e'))).rejects.toBeInstanceOf(
      PlatformErrorException,
    );
  });
});

describe('DefaultPrincipalMapper.fromClaims', () => {
  it('projects claims into a validated Principal', () => {
    // fromClaims is pure — the Context is only used by bindPrincipal, not exercised here.
    const mapper = new DefaultPrincipalMapper(undefined as never);
    const p = mapper.fromClaims({
      subject: 'prn_u1' as PrincipalId,
      tenantId: 'tnt_acme' as TenantId,
      kind: 'user',
      roles: ['customer'],
      scopes: ['tenant.role.read'] as Scope[],
    });
    expect(p).toMatchObject({
      id: 'prn_u1',
      tenantId: 'tnt_acme',
      kind: 'user',
      roles: ['customer'],
    });
  });
});
