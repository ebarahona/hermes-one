// Write-side substrate repositories (the CompiledPlanStore is read-mostly for content-addressed rows;
// these own the tenant-scoped authoring/deployment writes under RLS). definitions/deployments are
// tenant-owned and RLS-protected, so every write goes through withTenant → set_config('app.tenant_id').
import {and, desc, eq} from 'drizzle-orm';
import type {AuditEvent, TenantScope} from '@platform/contracts';
import {TenantAwareRepository} from './tenant-aware.repository.js';
import {insertAuditEvent} from './audit-repository.js';
import {enqueueOutboxRow, deriveOutboxId} from './event-outbox-repository.js';
import {
  definitions,
  definitionVersions,
  deployments,
  deploymentMembers,
} from './schema/substrate.schema.js';

export interface DefinitionRow {
  definitionId: string;
  kind: 'workflow' | 'rule' | 'policy' | 'capability' | 'agent-engine';
  name: string;
  schemaRef: string;
  currentVersion: string;
  status: 'draft' | 'validated' | 'compiled' | 'published' | 'deployed' | 'retired';
  labels?: Record<string, string>;
  createdBy: string;
}

export interface DefinitionVersionRow {
  definitionId: string;
  version: string;
  contentHash: string;
  family: 'logic-dsl' | 'contract-schema';
  status: 'validated' | 'compiled' | 'published' | 'deployed' | 'retired';
  body: unknown;
  compilerVersion?: string | null;
  diagnostics?: unknown[];
  createdBy: string;
}

export class DrizzleDefinitionRepository extends TenantAwareRepository {
  /** Upsert the authoring identity (current-version pointer) + append an immutable version row. */
  async putDefinition(
    def: DefinitionRow,
    version: DefinitionVersionRow,
    scope: TenantScope,
    events: AuditEvent[] = [],
  ): Promise<{versionInserted: boolean}> {
    return this.withTenant(scope, async tx => {
      await tx
        .insert(definitions)
        .values({
          definitionId: def.definitionId,
          tenantId: scope.tenantId,
          kind: def.kind,
          name: def.name,
          schemaRef: def.schemaRef,
          currentVersion: def.currentVersion,
          status: def.status,
          labels: def.labels ?? {},
          createdBy: def.createdBy,
        })
        .onConflictDoUpdate({
          target: definitions.definitionId,
          set: {currentVersion: def.currentVersion, status: def.status, updatedAt: new Date()},
        });

      const versionRows = await tx
        .insert(definitionVersions)
        .values({
          definitionId: version.definitionId,
          version: version.version,
          contentHash: version.contentHash,
          family: version.family,
          status: version.status,
          body: version.body,
          compilerVersion: version.compilerVersion ?? null,
          diagnostics: version.diagnostics ?? [],
          createdBy: version.createdBy,
        })
        .onConflictDoNothing({target: [definitionVersions.definitionId, definitionVersions.version]})
        .returning({definitionId: definitionVersions.definitionId});
      const versionInserted = versionRows.length > 0;

      // Commit-and-publish (F3, same rule as persistTurnAtomic): the audit event IS the domain event;
      // its outbox row rides THIS transaction. Emitted ONLY on a fresh version insert — an idempotent
      // re-put re-derives the same event and must not duplicate it (exactly-once, the billing rule).
      if (versionInserted) {
        for (const event of events) {
          await insertAuditEvent(tx, event);
          await enqueueOutboxRow(tx, {
            outboxId: deriveOutboxId(event.id),
            tenantId: event.tenantId,
            aggregateType: 'audit_event',
            aggregateId: event.id,
            eventType: event.action,
            payload: event as unknown as Record<string, unknown>,
          });
        }
      }
      return {versionInserted};
    });
  }

  async getDefinition(definitionId: string, scope: TenantScope): Promise<DefinitionRow | null> {
    return this.withTenant(scope, async tx => {
      const [row] = await tx
        .select()
        .from(definitions)
        .where(eq(definitions.definitionId, definitionId))
        .limit(1);
      if (!row) return null;
      return {
        definitionId: row.definitionId,
        kind: row.kind,
        name: row.name,
        schemaRef: row.schemaRef,
        currentVersion: row.currentVersion,
        status: row.status,
        labels: row.labels as Record<string, string>,
        createdBy: row.createdBy,
      };
    });
  }
}

export interface DeploymentRowInput {
  deploymentId: string;
  version: string;
  operatorRegistryVersion: string;
  notes?: string;
  createdBy: string;
}

export interface DeploymentMemberInput {
  kind: 'workflow' | 'agent-engine' | 'policy' | 'rule' | 'capability';
  seq: number;
  definitionId: string;
  planId: string | null;
  version: string;
  contentHash: string;
}

export class DrizzleDeploymentRepository extends TenantAwareRepository {
  /** The highest deployment version for a tenant, or null if none. */
  async latestVersion(scope: TenantScope): Promise<string | null> {
    return this.withTenant(scope, async tx => {
      const [row] = await tx
        .select({version: deployments.version, createdAt: deployments.createdAt})
        .from(deployments)
        .where(eq(deployments.tenantId, scope.tenantId))
        .orderBy(desc(deployments.createdAt))
        .limit(1);
      return row?.version ?? null;
    });
  }

  /**
   * Atomically supersede the current active deployment and insert the new active one + its members.
   * One-active-per-tenant is a DB invariant (deployments_tenant_active_uq); the txn fails loudly on a race.
   */
  async publish(
    dep: DeploymentRowInput,
    members: DeploymentMemberInput[],
    scope: TenantScope,
    events: AuditEvent[] = [],
  ): Promise<void> {
    await this.withTenant(scope, async tx => {
      await tx
        .update(deployments)
        .set({status: 'superseded'})
        .where(and(eq(deployments.tenantId, scope.tenantId), eq(deployments.status, 'active')));

      await tx.insert(deployments).values({
        deploymentId: dep.deploymentId,
        tenantId: scope.tenantId,
        version: dep.version,
        status: 'active',
        operatorRegistryVersion: dep.operatorRegistryVersion,
        notes: dep.notes,
        createdBy: dep.createdBy,
      });

      if (members.length > 0) {
        await tx.insert(deploymentMembers).values(
          members.map(m => ({
            deploymentId: dep.deploymentId,
            kind: m.kind,
            seq: m.seq,
            definitionId: m.definitionId,
            planId: m.planId,
            version: m.version,
            contentHash: m.contentHash,
          })),
        );
      }

      // Commit-and-publish (F3): deployment rows + audit trail + outbox in ONE transaction. Every
      // publish mints a NEW version, so events are unconditional here (no idempotent-replay branch).
      for (const event of events) {
        await insertAuditEvent(tx, event);
        await enqueueOutboxRow(tx, {
          outboxId: deriveOutboxId(event.id),
          tenantId: event.tenantId,
          aggregateType: 'audit_event',
          aggregateId: event.id,
          eventType: event.action,
          payload: event as unknown as Record<string, unknown>,
        });
      }
    });
  }

  /** Repoint active to a copy of an existing version's members as a new active version. */
  async repointActive(
    newDep: DeploymentRowInput,
    fromVersion: string,
    scope: TenantScope,
  ): Promise<void> {
    await this.withTenant(scope, async tx => {
      const [src] = await tx
        .select()
        .from(deployments)
        .where(and(eq(deployments.tenantId, scope.tenantId), eq(deployments.version, fromVersion)))
        .limit(1);
      if (!src) throw new Error(`rollback source version ${fromVersion} not found`);
      const srcMembers = await tx
        .select()
        .from(deploymentMembers)
        .where(eq(deploymentMembers.deploymentId, src.deploymentId));

      await tx
        .update(deployments)
        .set({status: 'superseded'})
        .where(and(eq(deployments.tenantId, scope.tenantId), eq(deployments.status, 'active')));

      await tx.insert(deployments).values({
        deploymentId: newDep.deploymentId,
        tenantId: scope.tenantId,
        version: newDep.version,
        status: 'active',
        operatorRegistryVersion: src.operatorRegistryVersion,
        notes: newDep.notes ?? `rollback to ${fromVersion}`,
        createdBy: newDep.createdBy,
      });

      if (srcMembers.length > 0) {
        await tx.insert(deploymentMembers).values(
          srcMembers.map(m => ({
            deploymentId: newDep.deploymentId,
            kind: m.kind,
            seq: m.seq,
            definitionId: m.definitionId,
            planId: m.planId,
            version: m.version,
            contentHash: m.contentHash,
          })),
        );
      }
    });
  }
}
