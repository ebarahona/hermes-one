// ProviderCredentialStore (edge plane): resolves the tenant-scoped secret bundle a provider adapter
// needs to reach its vendor (Twilio account SID/auth token/from number, etc.). This is the seam that
// security/secrets-and-key-management.md's KMS-backed ProviderCredentialStore fills in production —
// secrets are scoped to (tenantId, providerId, capability), never inlined in a contract, never logged,
// never crossing the Temporal-activity boundary as a literal (the adapter resolves them at execution
// time). FLAGGED (JIT): no cloud secret manager exists in this build yet, so the forward-build impl
// reads a static per-provider bundle supplied by the composition root from the environment. The
// (tenantId) argument is honored by the PORT (single-tenant bundle for now) — the per-tenant KMS
// realization is the follow-up owned by security/secrets-and-key-management.md.
import type {CapabilityName, TenantId} from '@platform/contracts';

/** Resolves the secret bundle for one (tenant, provider, capability). Never logged. */
export interface ProviderCredentialStore {
  resolve(
    tenantId: TenantId,
    providerId: string,
    capability: CapabilityName,
  ): Promise<Readonly<Record<string, string>>>;
}

/** Raised when no credential bundle is configured for a provider (fail-closed — never silently send). */
export class MissingCredentialsError extends Error {
  constructor(readonly providerId: string) {
    super(`no credentials configured for provider '${providerId}'`);
    this.name = 'MissingCredentialsError';
  }
}

/**
 * Static bundle store keyed by providerId — the forward-build stand-in for the KMS-backed store. The
 * composition root builds the map from the environment (secrets never enter a definition body). Tenant
 * scoping is a no-op here (one bundle per provider) and is flagged above.
 */
export class StaticProviderCredentialStore implements ProviderCredentialStore {
  constructor(private readonly byProvider: Readonly<Record<string, Readonly<Record<string, string>>>>) {}

  async resolve(
    _tenantId: TenantId,
    providerId: string,
    _capability: CapabilityName,
  ): Promise<Readonly<Record<string, string>>> {
    const bundle = this.byProvider[providerId];
    if (!bundle) throw new MissingCredentialsError(providerId);
    return bundle;
  }
}
