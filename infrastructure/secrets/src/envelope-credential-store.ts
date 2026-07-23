// EnvelopeCredentialStore (ADR-026): the per-tenant ProviderCredentialStore. Rows live in
// capability.provider_credentials (RLS strict, migration 0030); the bundle is envelope-encrypted by
// the injected CredentialCipher; rotation is a row UPDATE (atomic per credential set). This is what
// makes tenant #2 an onboarding row: their Twilio account is rotate()'d in, never deployed.
//
// The ROW store is a port so this class owns crypto + semantics and nothing else: Drizzle implements
// CredentialRowStore in infrastructure/drizzle (tenant-scoped via withTenant → RLS), keeping the
// dependency one-way (drizzle → secrets, type-only) and this member free of any DB client.
import type {
  CapabilityName,
  IsoTimestamp,
  ProviderCredentialRecord,
  ProviderCredentialStore,
  TenantId,
} from '@platform/contracts';
import type {CredentialCipher} from './credential-cipher.js';
import {MissingCredentialsError} from './static-credential-store.js';

export interface CredentialRow {
  credentialId: string;
  tenantId: TenantId;
  providerId: string;
  capability: CapabilityName;
  ciphertext: string;
  keyRef: string;
  status: 'active' | 'rotating' | 'revoked';
  rotatedAt: Date;
}

/** Tenant-scoped row access — implemented by Drizzle over capability.provider_credentials. */
export interface CredentialRowStore {
  get(tenantId: TenantId, providerId: string, capability: CapabilityName): Promise<CredentialRow | null>;
  /** Create-or-replace on the (tenant, provider, capability) unique key. */
  upsert(row: CredentialRow): Promise<void>;
  /** Returns whether an EXISTING row was updated — false when the tuple has no row at all. */
  setStatus(
    tenantId: TenantId,
    providerId: string,
    capability: CapabilityName,
    status: CredentialRow['status'],
  ): Promise<boolean>;
}

/** Raised when a credential exists but is revoked — distinct from absence for audit/operators. */
export class RevokedCredentialsError extends Error {
  readonly code = 'forbidden_scope' as const;
  readonly retryable = false as const;

  constructor(readonly providerId: string) {
    super(`credentials for provider '${providerId}' are revoked`);
    this.name = 'RevokedCredentialsError';
  }
}

export class EnvelopeCredentialStore implements ProviderCredentialStore {
  constructor(
    private readonly rows: CredentialRowStore,
    private readonly cipher: CredentialCipher,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async resolve(
    tenantId: TenantId,
    providerId: string,
    capability: CapabilityName,
  ): Promise<ProviderCredentialRecord> {
    const row = await this.rows.get(tenantId, providerId, capability);
    if (!row) throw new MissingCredentialsError(providerId);
    if (row.status === 'revoked') throw new RevokedCredentialsError(providerId);
    const plaintext = await this.cipher.decrypt(tenantId, row.ciphertext, row.keyRef);
    return {
      tenantId,
      providerId,
      capability,
      config: Object.freeze(JSON.parse(plaintext) as Record<string, string>),
      status: row.status,
      rotatedAt: row.rotatedAt.toISOString() as IsoTimestamp,
    };
  }

  async rotate(
    tenantId: TenantId,
    providerId: string,
    capability: CapabilityName,
    config: Readonly<Record<string, string>>,
  ): Promise<void> {
    const {ciphertext, keyRef} = await this.cipher.encrypt(tenantId, JSON.stringify(config));
    await this.rows.upsert({
      credentialId: credentialIdFor(tenantId, providerId, capability),
      tenantId,
      providerId,
      capability,
      ciphertext,
      keyRef,
      status: 'active',
      rotatedAt: this.clock(),
    });
  }

  async revoke(tenantId: TenantId, providerId: string, capability: CapabilityName): Promise<void> {
    const updated = await this.rows.setStatus(tenantId, providerId, capability, 'revoked');
    if (updated) return;
    // No row for the tuple: revocation intent must STILL stick durably (ADR-026 — revoke fail-closes,
    // never falls through). A bare no-op UPDATE here would leave nothing behind, and a layered store
    // (FallbackCredentialStore) would keep serving the platform bundle for a tuple an operator
    // explicitly killed. So write a revoked TOMBSTONE row: the sentinel ciphertext/keyRef satisfy the
    // schema's NOT NULLs but are never decrypted (resolve fail-closes on status before touching the
    // cipher), and a later rotate() replaces the tombstone in place like any other row.
    await this.rows.upsert({
      credentialId: credentialIdFor(tenantId, providerId, capability),
      tenantId,
      providerId,
      capability,
      ciphertext: REVOKED_TOMBSTONE,
      keyRef: REVOKED_TOMBSTONE,
      status: 'revoked',
      rotatedAt: this.clock(),
    });
  }
}

/** Deterministic row id for the (tenant, provider, capability) tuple — satisfies the 'pvc_%' CHECK. */
const credentialIdFor = (tenantId: TenantId, providerId: string, capability: CapabilityName): string =>
  `pvc_${tenantId}_${providerId}_${capability}`.replace(/[^a-zA-Z0-9_]/g, '_');

/** Sentinel for a revoked-with-no-prior-row tombstone — schema-legal, never decrypted. */
const REVOKED_TOMBSTONE = 'revoked:tombstone';

/**
 * Tenant rows first, platform defaults second — the credential mirror of provider_mappings'
 * "absence of a row means use the default". A tenant that has NOT brought its own vendor account
 * rides the platform's; one that HAS gets its own, no deploy. Revocation is NOT a fallthrough:
 * a revoked tenant credential fails closed rather than silently borrowing the platform bundle.
 */
export class FallbackCredentialStore implements ProviderCredentialStore {
  constructor(
    private readonly primary: ProviderCredentialStore,
    private readonly fallback: ProviderCredentialStore,
  ) {}

  async resolve(
    tenantId: TenantId,
    providerId: string,
    capability: CapabilityName,
  ): Promise<ProviderCredentialRecord> {
    try {
      return await this.primary.resolve(tenantId, providerId, capability);
    } catch (err) {
      if (err instanceof MissingCredentialsError) return this.fallback.resolve(tenantId, providerId, capability);
      throw err; // revoked / cipher failures NEVER fall through
    }
  }

  rotate(
    tenantId: TenantId,
    providerId: string,
    capability: CapabilityName,
    config: Readonly<Record<string, string>>,
  ): Promise<void> {
    return this.primary.rotate(tenantId, providerId, capability, config);
  }

  revoke(tenantId: TenantId, providerId: string, capability: CapabilityName): Promise<void> {
    return this.primary.revoke(tenantId, providerId, capability);
  }
}
