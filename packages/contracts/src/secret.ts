// @platform/contracts — src/secret.ts
// The secret-pointer grammar + resolution port, transcribed VERBATIM from
// security/secrets-and-key-management.md. The spec splits these across `secret-ref.ts` (contract)
// and `infrastructure/secrets/src/secret-provider.ts`; both are pure TS, so contracts hosts them
// until the dedicated secrets infrastructure member exists (flagged — same hosting rule as
// composition-root.ts). NO resolved secret value is ever logged, stored in a definition body,
// prompt, or the config object at rest — config carries only `secret://` refs.
import {z} from 'zod';

/** `secret://<store>/<path...>` — the ONE secret-pointer grammar used everywhere in the platform
 *  (binding-key-registry.md CONFIG, authentication-strategies.md jwksRef/trustBundleRef,
 *  provider-contracts.md configKey resolve through this same grammar). */
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
 * manager's read API directly.
 */
export interface SecretProvider {
  resolve(ref: SecretRef): Promise<ResolvedSecret>;
  /** Drop a cached entry (called on a rotation event so the next resolve() re-fetches). */
  invalidate(ref: SecretRef): void;
}
