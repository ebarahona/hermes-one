// tenant.vertical_pack_installations (ADR-013): the durable record of WHICH
// vertical pack a tenant installed, at what version, and which definitions it minted — written by
// the installer in the same breath as the publish, so "what packs does this tenant run?" is a
// tenant-scoped query instead of archaeology over definitions. RLS strict like every tenant table.
import {eq, and} from 'drizzle-orm';
import type {PrincipalId, TenantId} from '@platform/contracts';
import {TenantAwareRepository} from './tenant-aware.repository.js';
import {verticalPackInstallations} from './schema/tenant.schema.js';

export interface InstalledDefinitionRef {
  kind: string;
  definitionId: string;
  version: string;
}

export interface VerticalPackInstallation {
  installationId: string;
  tenantId: TenantId;
  packId: string;
  packVersion: string;
  status: 'installing' | 'active' | 'disabled' | 'failed';
  installedDefinitions: InstalledDefinitionRef[];
  installedBy: PrincipalId;
}

export class DrizzleVerticalPackInstallationRepository extends TenantAwareRepository {
  /** Create-or-replace on (tenant, pack) — a re-install records the newest version/defs. */
  async record(install: VerticalPackInstallation): Promise<void> {
    await this.withTenant({tenantId: install.tenantId}, tx =>
      tx
        .insert(verticalPackInstallations)
        .values({
          installationId: install.installationId,
          tenantId: install.tenantId,
          packId: install.packId,
          packVersion: install.packVersion,
          status: install.status,
          installedDefinitions: install.installedDefinitions,
          installedBy: install.installedBy,
        })
        .onConflictDoUpdate({
          target: [
            verticalPackInstallations.tenantId,
            verticalPackInstallations.packId,
          ],
          set: {
            packVersion: install.packVersion,
            status: install.status,
            installedDefinitions: install.installedDefinitions,
            installedBy: install.installedBy,
            updatedAt: new Date(),
          },
        }),
    );
  }

  async get(
    tenantId: TenantId,
    packId: string,
  ): Promise<VerticalPackInstallation | null> {
    return this.withTenant({tenantId}, async tx => {
      const rows = await tx
        .select()
        .from(verticalPackInstallations)
        .where(
          and(
            eq(verticalPackInstallations.tenantId, tenantId),
            eq(verticalPackInstallations.packId, packId),
          ),
        );
      const r = rows[0];
      if (!r) return null;
      return {
        installationId: r.installationId,
        tenantId: r.tenantId as TenantId,
        packId: r.packId,
        packVersion: r.packVersion,
        status: r.status,
        installedDefinitions: (r.installedDefinitions ??
          []) as InstalledDefinitionRef[],
        installedBy: r.installedBy as PrincipalId,
      };
    });
  }
}
