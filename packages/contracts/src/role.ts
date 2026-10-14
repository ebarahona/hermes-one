// @platform/contracts — src/role.ts
// Role definitions + the role→scope resolution port, defined here. Roles are the SOURCE; scopes are derived per request and never
// stored on a principal row or cached (ADR-019 "scopes are the one visibility source"; no table stores
// Principal.scopes — a role edit takes effect on the next request).
import {z} from 'zod';
import {TenantId, IsoTimestamp} from './substrate.js';
import {Scope} from './tenant.js';

export const RoleId = z.string().min(1).brand('RoleId'); // 'rol_...'
export type RoleId = z.infer<typeof RoleId>;

/** Mirrors `tenant.roles` exactly — no drift. */
export const RoleDefinition = z.object({
  roleId: RoleId,
  /** null = platform-defined, available to every tenant (mirrors substrate.definitions nullable-tenant). */
  tenantId: TenantId.nullable(),
  /** The join key `Principal.roles` / `tenant.users.role_names` reference by string. Immutable after create. */
  name: z.string().min(1).max(100).regex(/^[a-z][a-z0-9-]*$/),
  scopes: z.array(Scope),
  description: z.string().max(500).optional(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type RoleDefinition = z.infer<typeof RoleDefinition>;

export type RoleCreateInput = Omit<RoleDefinition, 'roleId' | 'createdAt' | 'updatedAt'>;
/** `name` excluded — rename is forbidden (role matrix). */
export type RoleUpdateInput = Partial<Pick<RoleDefinition, 'scopes' | 'description'>>;

/**
 * Authors roles and resolves role NAMES → scopes at runtime. Bound at platform.tenant.roleRegistry,
 * Application scope (each method opens its own tenant-scoped transaction, ADR-022). @public
 */
export interface RoleRegistry {
  /** Platform roles (tenantId=null) unioned with this tenant's own roles. */
  list(tenantId: TenantId): Promise<RoleDefinition[]>;
  /** Tenant row wins over a platform row of the same `name` (shadowing), else falls back to platform. */
  get(tenantId: TenantId, name: string): Promise<RoleDefinition | null>;
  create(input: RoleCreateInput): Promise<RoleDefinition>;
  update(roleId: RoleId, patch: RoleUpdateInput): Promise<RoleDefinition>;
  /** Deleting a platform role (tenantId=null) is rejected outside a platform-admin migration path. */
  delete(roleId: RoleId): Promise<void>;
  /** Runtime resolution: role NAMES (Principal.roles) → deduped, unioned Scope[]. Never cached. */
  resolveScopes(tenantId: TenantId, roleNames: readonly string[]): Promise<Scope[]>;
}
