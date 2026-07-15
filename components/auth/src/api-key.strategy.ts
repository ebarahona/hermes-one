// ApiKeyStrategy — the api-key AuthStrategy (authentication-strategies.md). The spec gives no concrete
// strategy body (only the ApiKeyStore/ApiKeyRecord port + the `apiKey` config), so this is authored
// JIT to the port. Steps: recognise the configured header → resolve the presented key through the
// (hashed, constant-time) ApiKeyStore → enforce status/expiry → mint a `service` Principal whose
// scopes come straight off the key record (no RoleRegistry — api-key scopes are on the key). Stateless
// single-request credential: sessionExpiry mirrors the key's expiry; authStrength 'api-key'.
import {inject, injectable} from '@loopback/core';
import type {Request} from '@loopback/rest';
import {
  type ApiKeyStore,
  type AuthenticatedIdentity,
  AuthenticatedIdentity as AuthenticatedIdentitySchema,
  Principal,
  type Scope,
} from '@platform/contracts';
import type {AuthStrategy, AuthConfig} from './contracts.js';
import {unauthorizedError} from './contracts.js';
import {AuthBindings} from './auth.bindings.js';

@injectable()
export class ApiKeyStrategy implements AuthStrategy {
  readonly name = 'api-key' as const;

  constructor(
    @inject(AuthBindings.API_KEY_STORE) private readonly store: ApiKeyStore,
    @inject(AuthBindings.CONFIG) private readonly config: AuthConfig,
  ) {}

  private header(): string {
    return this.config.apiKey.header.toLowerCase();
  }

  applies(request: Request): boolean {
    return typeof request.headers[this.header()] === 'string';
  }

  async authenticate(request: Request): Promise<AuthenticatedIdentity | undefined> {
    const raw = request.headers[this.header()];
    const presented = Array.isArray(raw) ? raw[0] : raw;
    if (!presented) return undefined; // shape didn't apply after all

    const record = await this.store.resolve(presented);
    // Fail-closed: unknown, revoked, or expired key → unauthorized (never distinguish which).
    if (!record || record.status !== 'active') throw unauthorizedError('api_key_unknown_or_revoked');
    if (record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.now()) {
      throw unauthorizedError('api_key_expired');
    }

    const principal = Principal.parse({
      id: record.principalId,
      tenantId: record.tenantId,
      kind: 'service',
      roles: [],
      scopes: record.scopes as Scope[], // scopes are carried on the key record
      attributes: {},
    });

    return AuthenticatedIdentitySchema.parse({
      principal,
      method: 'api-key',
      authStrength: 'api-key',
      sessionExpiry: record.expiresAt,
      authenticatedAt: new Date().toISOString(),
    });
  }
}
