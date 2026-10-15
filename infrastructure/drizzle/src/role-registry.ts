// DrizzleRoleRegistry — the canonical RoleRegistry port over tenant.roles
// (nullable-tenant RLS: a session sees its tenant's rows + platform NULL rows). AUTH-2
// (docs/design/001-edge-authn-design.md): roles are the source; scopes are derived per request via
// resolveScopes and NEVER cached — a role edit takes effect on the next request. Shadowing: a tenant
// row wins over the platform row of the same name.
import {and, eq, inArray, isNull, or, sql} from 'drizzle-orm';
import {
  PlatformErrorException,
  type RoleCreateInput,
  type RoleDefinition,
  type RoleId,
  type RoleRegistry,
  type RoleUpdateInput,
  type Scope,
  type TenantId,
} from '@platform/contracts';
import {
  TenantAwareRepository,
  type PlatformTx,
} from './tenant-aware.repository.js';
import {roles} from './schema/tenant.schema.js';

type RoleRow = typeof roles.$inferSelect;

const toDefinition = (r: RoleRow): RoleDefinition =>
  ({
    roleId: r.roleId,
    tenantId: r.tenantId,
    name: r.name,
    scopes: r.scopes,
    description: r.description ?? undefined,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }) as RoleDefinition;

/** Tenant rows shadow platform rows of the same name. */
const shadow = (rows: RoleRow[]): Map<string, RoleRow> => {
  const byName = new Map<string, RoleRow>();
  for (const r of rows) {
    const existing = byName.get(r.name);
    if (!existing || (existing.tenantId === null && r.tenantId !== null))
      byName.set(r.name, r);
  }
  return byName;
};

export class DrizzleRoleRegistry
  extends TenantAwareRepository
  implements RoleRegistry
{
  async list(tenantId: TenantId): Promise<RoleDefinition[]> {
    return this.withTenant({tenantId}, async tx => {
      const rows = await tx
        .select()
        .from(roles)
        .where(or(eq(roles.tenantId, tenantId), isNull(roles.tenantId)));
      return [...shadow(rows).values()].map(toDefinition);
    });
  }

  async get(tenantId: TenantId, name: string): Promise<RoleDefinition | null> {
    return this.withTenant({tenantId}, async tx => {
      const rows = await tx
        .select()
        .from(roles)
        .where(
          and(
            eq(roles.name, name),
            or(eq(roles.tenantId, tenantId), isNull(roles.tenantId)),
          ),
        );
      const winner = shadow(rows).get(name);
      return winner ? toDefinition(winner) : null;
    });
  }

  async create(input: RoleCreateInput): Promise<RoleDefinition> {
    // Platform rows (tenantId=null) cannot be written under a tenant GUC (strict WITH CHECK would
    // reject a mismatched tenant anyway) — creating them is the seed-migration path, not this port.
    if (input.tenantId === null) {
      throw this.forbidden(
        'platform roles (tenantId=null) are seeded by migration, not created at runtime',
      );
    }
    const roleId =
      `rol_${input.tenantId.replace(/[^a-z0-9]/gi, '')}_${input.name.replace(/-/g, '')}` as RoleId;
    return this.withTenant({tenantId: input.tenantId}, async tx => {
      const [row] = await tx
        .insert(roles)
        .values({
          roleId,
          tenantId: input.tenantId,
          name: input.name,
          scopes: [...input.scopes],
          description: input.description,
        })
        .returning();
      return toDefinition(row);
    });
  }

  /**
   * FLAGGED (design doc AUTH-2): update/delete take only a roleId (the port shape) —
   * under RLS they need the ADMIN request context that establishes the tenant GUC, which is the
   * Tier-4 admin surface. The tenant-scoped cores below (`updateFor`/`deleteFor`) are the real
   * implementations; the port methods fail loud until the admin context exists. AUTH-2's runtime
   * paths (list/get/create/resolveScopes) are complete.
   */
  async update(
    _roleId: RoleId,
    _patch: RoleUpdateInput,
  ): Promise<RoleDefinition> {
    throw this.forbidden(
      'RoleRegistry.update requires the admin request tenant context (Tier 4) — use updateFor',
    );
  }
  async delete(_roleId: RoleId): Promise<void> {
    throw this.forbidden(
      'RoleRegistry.delete requires the admin request tenant context (Tier 4) — use deleteFor',
    );
  }

  async updateFor(
    tenantId: TenantId,
    roleId: RoleId,
    patch: RoleUpdateInput,
  ): Promise<RoleDefinition> {
    return this.withTenant({tenantId}, async tx => {
      const [row] = await tx
        .update(roles)
        .set({
          ...(patch.scopes ? {scopes: [...patch.scopes]} : {}),
          ...(patch.description !== undefined
            ? {description: patch.description}
            : {}),
          updatedAt: sql`now()`,
        })
        .where(and(eq(roles.roleId, roleId), eq(roles.tenantId, tenantId)))
        .returning();
      if (!row) throw this.notFound(`role not found: ${roleId}`);
      return toDefinition(row);
    });
  }

  /** Platform NULL rows are invisible to a tenant scope — deleting them stays a migration path. */
  async deleteFor(tenantId: TenantId, roleId: RoleId): Promise<void> {
    await this.withTenant({tenantId}, async tx => {
      await tx
        .delete(roles)
        .where(and(eq(roles.roleId, roleId), eq(roles.tenantId, tenantId)));
    });
  }

  async resolveScopes(
    tenantId: TenantId,
    roleNames: readonly string[],
  ): Promise<Scope[]> {
    if (roleNames.length === 0) return [];
    return this.withTenant({tenantId}, tx =>
      this.resolveScopesIn(tx, tenantId, roleNames),
    );
  }

  /** Tx-scoped core (composable into a caller's transaction, same pattern as the persistence cores). */
  async resolveScopesIn(
    tx: PlatformTx,
    tenantId: TenantId,
    roleNames: readonly string[],
  ): Promise<Scope[]> {
    const rows = await tx
      .select()
      .from(roles)
      .where(
        and(
          inArray(roles.name, [...roleNames]),
          or(eq(roles.tenantId, tenantId), isNull(roles.tenantId)),
        ),
      );
    const winners = shadow(rows);
    const out = new Set<string>();
    for (const name of roleNames)
      for (const s of winners.get(name)?.scopes ?? []) out.add(s);
    return [...out] as Scope[];
  }

  private notFound(message: string): PlatformErrorException {
    return new PlatformErrorException({
      category: 'not-found',
      code: 'not_found',
      message,
      issues: [],
      retryable: false,
      httpStatus: 404,
    });
  }
  private forbidden(message: string): PlatformErrorException {
    return new PlatformErrorException({
      category: 'authorization',
      code: 'forbidden_scope',
      message,
      issues: [],
      retryable: false,
      httpStatus: 403,
    });
  }
}
