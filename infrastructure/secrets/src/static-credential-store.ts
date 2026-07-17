// The env-backed ProviderCredentialStore stand-in, MOVED here from components/channels (ledger S7):
// the port was trapped in an edge-plane component (@loopback/* deps), which made it structurally
// unimportable from the agent plane (ADR-017 / plane-lint) — the root cause of PE7. The PORT now
// lives in @platform/contracts beside the other ports; this member (the one the spec assigns,
// security/secrets-and-key-management.md) hosts implementations, plane `none` so BOTH planes wire it.
//
// Tenant scoping is still a stand-in here (one bundle per provider, from the environment at the
// composition root). The per-tenant envelope-encrypted store is ADR-026's build (ledger S1/S6) —
// same port, different adapter.
import type {
  CapabilityName,
  IsoTimestamp,
  ProviderCredentialRecord,
  ProviderCredentialStore,
  TenantId,
} from '@platform/contracts';

/** Raised when no credential bundle is configured for a provider (fail-closed — never silently send). */
export class MissingCredentialsError extends Error {
  readonly code = 'not_found' as const;
  readonly retryable = false as const;

  constructor(readonly providerId: string) {
    super(`no credentials configured for provider '${providerId}'`);
    this.name = 'MissingCredentialsError';
  }
}

/**
 * Static bundle store keyed by providerId. Fail-closed: an ABSENT bundle throws; a provider that
 * genuinely needs no credentials (internal-scheduler, internal-message-log) is declared with an
 * EXPLICIT empty bundle `{}` — absence and credential-lessness are different facts.
 */
export class StaticProviderCredentialStore implements ProviderCredentialStore {
  constructor(
    private readonly byProvider: Readonly<Record<string, Readonly<Record<string, string>>>>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async resolve(
    tenantId: TenantId,
    providerId: string,
    capability: CapabilityName,
  ): Promise<ProviderCredentialRecord> {
    const bundle = this.byProvider[providerId];
    if (!bundle) throw new MissingCredentialsError(providerId);
    return {
      tenantId,
      providerId,
      capability,
      config: bundle,
      status: 'active',
      rotatedAt: this.clock().toISOString() as IsoTimestamp,
    };
  }

  /** Env-backed and immutable — rotation happens where the env does. Fail loudly, never pretend. */
  async rotate(): Promise<void> {
    throw new Error('StaticProviderCredentialStore cannot rotate — configure the envelope store (ADR-026)');
  }

  async revoke(): Promise<void> {
    throw new Error('StaticProviderCredentialStore cannot revoke — configure the envelope store (ADR-026)');
  }
}
