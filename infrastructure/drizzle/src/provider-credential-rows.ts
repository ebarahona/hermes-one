// Tenant-scoped row access for capability.provider_credentials (migration 0030, RLS strict) —
// implements @platform-internal/secrets' CredentialRowStore port so EnvelopeCredentialStore owns
// crypto + semantics and this class owns ONLY rows. Every access goes through withTenant →
// set_config('app.tenant_id') like every other tenant repo; the ciphertext column is opaque here.
import {and, eq} from 'drizzle-orm';
import type {CapabilityName, TenantId} from '@platform/contracts';
import type {CredentialRow, CredentialRowStore} from '@platform-internal/secrets';
import {TenantAwareRepository} from './tenant-aware.repository.js';
import {providerCredentials} from './schema/capability.schema.js';

export class DrizzleCredentialRowStore extends TenantAwareRepository implements CredentialRowStore {
  async get(tenantId: TenantId, providerId: string, capability: CapabilityName): Promise<CredentialRow | null> {
    return this.withTenant({tenantId}, async tx => {
      const rows = await tx
        .select()
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.tenantId, tenantId),
            eq(providerCredentials.providerId, providerId),
            eq(providerCredentials.capability, capability),
          ),
        );
      const r = rows[0];
      if (!r) return null;
      return {
        credentialId: r.credentialId,
        tenantId: r.tenantId as TenantId,
        providerId: r.providerId,
        capability: r.capability as CapabilityName,
        ciphertext: r.ciphertext,
        keyRef: r.keyRef,
        status: r.status,
        rotatedAt: r.rotatedAt,
      };
    });
  }

  async upsert(row: CredentialRow): Promise<void> {
    await this.withTenant({tenantId: row.tenantId}, tx =>
      tx
        .insert(providerCredentials)
        .values({
          credentialId: row.credentialId,
          tenantId: row.tenantId,
          providerId: row.providerId,
          capability: row.capability,
          ciphertext: row.ciphertext,
          keyRef: row.keyRef,
          status: row.status,
          rotatedAt: row.rotatedAt,
        })
        .onConflictDoUpdate({
          target: [providerCredentials.tenantId, providerCredentials.providerId, providerCredentials.capability],
          set: {ciphertext: row.ciphertext, keyRef: row.keyRef, status: row.status, rotatedAt: row.rotatedAt},
        }),
    );
  }

  async setStatus(
    tenantId: TenantId,
    providerId: string,
    capability: CapabilityName,
    status: CredentialRow['status'],
  ): Promise<void> {
    await this.withTenant({tenantId}, tx =>
      tx
        .update(providerCredentials)
        .set({status})
        .where(
          and(
            eq(providerCredentials.tenantId, tenantId),
            eq(providerCredentials.providerId, providerId),
            eq(providerCredentials.capability, capability),
          ),
        ),
    );
  }
}
