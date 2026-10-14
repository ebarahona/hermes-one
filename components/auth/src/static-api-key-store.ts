// StaticApiKeyStore — a config/seed-backed realization of the `ApiKeyStore` port.
// The design leaves the ApiKeyStore BACKING "prose/port-only,
// deferred" — no table DDL — so this in-memory store is the faithful stand-in, mirroring AUTH-1's
// webhook `tenantByNumber` map and the `StaticProviderCredentialStore` seam.
//
// Why NOT a DrizzleApiKeyStore yet (flagged, ledger): `resolve(presentedKey)` takes ONLY the key, so
// the lookup is inherently PRE-TENANT (the key alone determines the tenant) — a cross-tenant read of
// an RLS-forced, tenant-owned table. That hits the unresolved relay-role / platform-admin cross-tenant
// posture (design 001 Open Questions; same tension as the outbox aggregator). A DB-backed store lands
// with that posture; tenant-scoped admin CRUD of keys (a later slice) can be tenant-scoped.
import {createHash, timingSafeEqual} from 'node:crypto';
import {type ApiKeyRecord, ApiKeyRecord as ApiKeyRecordSchema, type ApiKeyStore} from '@platform/contracts';

export type ApiKeyHashAlgo = 'sha-256' | 'sha-512';

/** A dev/seed entry: the plaintext key + the record it authenticates as. */
export interface ApiKeySeed {
  readonly key: string;
  readonly record: ApiKeyRecord;
}

function hash(algo: ApiKeyHashAlgo, key: string): Buffer {
  return createHash(algo === 'sha-512' ? 'sha512' : 'sha256').update(key, 'utf8').digest();
}

export class StaticApiKeyStore implements ApiKeyStore {
  private readonly entries: {hash: Buffer; record: ApiKeyRecord}[];

  constructor(seeds: readonly ApiKeySeed[], private readonly algo: ApiKeyHashAlgo = 'sha-256') {
    this.entries = seeds.map(s => ({hash: hash(algo, s.key), record: ApiKeyRecordSchema.parse(s.record)}));
  }

  /** Constant-time hashed lookup. undefined ⇒ unknown key. Status/expiry are enforced by the strategy. */
  async resolve(presentedKey: string): Promise<ApiKeyRecord | undefined> {
    const presented = hash(this.algo, presentedKey);
    for (const e of this.entries) {
      // Equal-length digests (same algo) → timingSafeEqual is safe and constant-time per entry.
      if (e.hash.length === presented.length && timingSafeEqual(e.hash, presented)) return e.record;
    }
    return undefined;
  }
}
