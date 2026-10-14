// @platform/contracts — src/secret.ts
// The secret-pointer grammar + resolution port, defined here. The grammar (`secret-ref.ts`) and the
// provider port (`infrastructure/secrets/src/secret-provider.ts`) are pure TS, so contracts hosts them
// until the dedicated secrets infrastructure member exists (flagged — same hosting rule as
// composition-root.ts). NO resolved secret value is ever logged, stored in a definition body,
// prompt, or the config object at rest — config carries only `secret://` refs.
import {z} from 'zod';
import type {CapabilityName} from './capability.js';
import type {IsoTimestamp, TenantId} from './substrate.js';

/** `secret://<store>/<path...>` — the ONE secret-pointer grammar used everywhere in the platform
 *  (binding-key registry CONFIG, authentication-strategies jwksRef/trustBundleRef,
 *  provider-contract configKey resolve through this same grammar). */
export const SecretRef = z
  .string()
  .regex(/^secret:\/\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/, 'expected "secret://<store>/<path>"')
  .brand('SecretRef');
export type SecretRef = z.infer<typeof SecretRef>;

export interface ResolvedSecret {
  readonly value: string;
  /** Secret-manager version id — used for rotation-aware cache invalidation and audit. */
  readonly version: string;
  readonly resolvedAt: string; // IsoTimestamp
}

/**
 * Bound at platform.config.secret-provider. Lazily resolves any SecretRef against the backing
 * store; caches with TTL; never logs a resolved value. The ONLY component that talks to the secret
 * manager's read API directly. Canonical per ADR-025 (the competing secrets-registry port is
 * superseded); this chain carries PLATFORM secrets only — O(1) in tenants.
 */
export interface SecretProvider {
  resolve(ref: SecretRef): Promise<ResolvedSecret>;
  /** Drop a cached entry (called on a rotation event so the next resolve() re-fetches). */
  invalidate(ref: SecretRef): void;
}

/* --------------------- Tenant provider credentials (ADR-026) --------------------- */

/**
 * One tenant's credential set for one provider serving one capability — the SECOND trust chain
 * (ADR-026): envelope-encrypted rows under the tenant CMK, NOT secret-manager entries (per-secret
 * pricing/quotas are O(tenants × providers) on the dispatch hot path). Deviation from the
 * earlier secrets design RATIFIED by ADR-026: the record carries the
 * DECRYPTED `config` (decrypt happens behind the port — only one component touches key material),
 * reconciling that design's interface-vs-sequence-diagram conflict (ledger S6); the orphaned
 * `configKey` is deleted — the (tenant, provider, capability) tuple IS the identifier.
 */
export interface ProviderCredentialRecord {
  readonly tenantId: TenantId;
  readonly providerId: string;
  readonly capability: CapabilityName;
  /** Decrypted bundle for ProviderExecutionContext.config. NEVER logged, NEVER in a contract body. */
  readonly config: Readonly<Record<string, string>>;
  readonly status: 'active' | 'rotating' | 'revoked';
  readonly rotatedAt: IsoTimestamp;
}

/**
 * Bound at platform.provider.credentialStore (camelCase per the registry-sync list).
 * Fail-closed: no bundle → throws (never silently send); a credential-LESS internal provider is an
 * EXPLICIT empty bundle, not an absent one; a REVOKED credential throws.
 * `rotate` is the ONLY write path — credentials enter the store already-typed and leave encrypted;
 * rotation is dual-version-free by design (ADR-026: a row update, atomic per credential set).
 */
export interface ProviderCredentialStore {
  resolve(
    tenantId: TenantId,
    providerId: string,
    capability: CapabilityName,
  ): Promise<ProviderCredentialRecord>;
  /** Create-or-replace the tenant's bundle for (provider, capability). Never logs the config. */
  rotate(
    tenantId: TenantId,
    providerId: string,
    capability: CapabilityName,
    config: Readonly<Record<string, string>>,
  ): Promise<void>;
  /** Kill-switch: subsequent resolves fail-closed until a new rotate(). */
  revoke(tenantId: TenantId, providerId: string, capability: CapabilityName): Promise<void>;
}
