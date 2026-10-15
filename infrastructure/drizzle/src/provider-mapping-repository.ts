// DrizzleProviderMappingRepository — the tenant OVERRIDE surface over capability.provider_mappings
// (migration 0023, RLS strict via 0024).
// Absence of a row = "use the contract default"; `findContractDefault` reads that default straight off
// the content-hashed capability contract via the substrate.capability_registrations view (published,
// latest by updated_at) — the view isn't modeled in the Drizzle schema (not DDL, not in the drift gate),
// so it's read with a raw `sql` template through `withTenant`'s tx, exactly like the RLS self-check's
// GUC probes. Every access goes through withTenant → set_config('app.tenant_id') like every other
// tenant repo (ADR-022).
import {and, eq, sql} from 'drizzle-orm';
import type {
  CapabilityName,
  ProviderMapping,
  TenantId,
} from '@platform/contracts';
import {TenantAwareRepository} from './tenant-aware.repository.js';
import {providerMappings} from './schema/capability.schema.js';

/** Deterministic 'pvm_...' id from (tenantId, capabilityName) — the pvc_ id recipe (envelope-credential-store.ts). */
function providerMappingId(tenantId: TenantId, name: CapabilityName): string {
  return `pvm_${tenantId}_${name}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

export class DrizzleProviderMappingRepository extends TenantAwareRepository {
  async find(
    tenantId: TenantId,
    name: CapabilityName,
  ): Promise<
    (ProviderMapping & {updatedAt: string; updatedBy: string}) | null
  > {
    return this.withTenant({tenantId}, async tx => {
      const rows = await tx
        .select()
        .from(providerMappings)
        .where(
          and(
            eq(providerMappings.tenantId, tenantId),
            eq(providerMappings.capabilityName, name),
          ),
        );
      const row = rows[0];
      if (!row) return null;
      return {
        providers: row.providers as ProviderMapping['providers'],
        eligibility: row.eligibility as ProviderMapping['eligibility'],
        onNoProvider: row.onNoProvider,
        updatedAt: row.updatedAt.toISOString(),
        updatedBy: row.updatedBy,
      };
    });
  }

  async upsert(
    tenantId: TenantId,
    name: CapabilityName,
    mapping: ProviderMapping,
    updatedBy: string,
  ): Promise<void> {
    await this.withTenant({tenantId}, tx =>
      tx
        .insert(providerMappings)
        .values({
          providerMappingId: providerMappingId(tenantId, name),
          tenantId,
          capabilityName: name,
          providers: mapping.providers,
          eligibility: mapping.eligibility,
          onNoProvider: mapping.onNoProvider,
          updatedAt: new Date(),
          updatedBy,
        })
        .onConflictDoUpdate({
          target: [providerMappings.tenantId, providerMappings.capabilityName],
          set: {
            providers: mapping.providers,
            eligibility: mapping.eligibility,
            onNoProvider: mapping.onNoProvider,
            updatedAt: new Date(),
            updatedBy,
          },
        }),
    );
  }

  async remove(tenantId: TenantId, name: CapabilityName): Promise<void> {
    await this.withTenant({tenantId}, tx =>
      tx
        .delete(providerMappings)
        .where(
          and(
            eq(providerMappings.tenantId, tenantId),
            eq(providerMappings.capabilityName, name),
          ),
        ),
    );
  }

  /** The contract's own default ProviderMapping (published, latest by updated_at) — null if no
   *  published capability contract exists at all under this name for this tenant. */
  async findContractDefault(
    tenantId: TenantId,
    name: CapabilityName,
  ): Promise<ProviderMapping | null> {
    return this.withTenant({tenantId}, async tx => {
      const res = await tx.execute(sql`
        SELECT contract_body
        FROM substrate.capability_registrations
        WHERE tenant_id = ${tenantId} AND capability_name = ${name} AND status = 'published'
        ORDER BY updated_at DESC
        LIMIT 1
      `);
      const row = res.rows[0] as
        {contract_body?: {providerMapping?: ProviderMapping}} | undefined;
      return row?.contract_body?.providerMapping ?? null;
    });
  }
}
