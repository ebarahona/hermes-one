// RoleController — the first datasource-backed admin route (api/admin-api.md §RoleController):
//   GET /v1/tenants/{tenantId}/roles   scope: tenant.role.read   posture: tenant-scoped read.
// Reads through the tenant-scoped, RLS-enforced DrizzleRoleRegistry (which opens the tenant GUC per
// call). Fail-closed on both axes: the scope gate (assertScope → 403 forbidden_scope) and the tenant
// boundary (a principal may only read its OWN tenant's roles — a path/principal mismatch is 403; the
// query always uses the TRUSTED principal.tenantId, never the path). Cross-tenant/platform-operator
// listing (POST/GET /v1/tenants) stays deferred on the RLS relay-role block.
import {inject} from '@loopback/core';
import {get, param} from '@loopback/rest';
import {PlatformBindings} from '@platform-internal/loopback-core';
import {assertScope, forbiddenScopeError} from '@platform-internal/auth';
import type {Principal, RoleRegistry, Scope, TenantId} from '@platform/contracts';

const READ_ROLES = 'tenant.role.read' as Scope;

/** Response shape (admin-api.md §RoleController — plain array, no pagination). */
export interface RoleDto {
  roleId: string;
  name: string;
  scopes: string[];
}

export class RoleController {
  constructor(
    @inject(PlatformBindings.REQUEST_PRINCIPAL) private readonly principal: Principal,
    @inject(PlatformBindings.ROLE_REGISTRY) private readonly roles: RoleRegistry,
  ) {}

  @get('/v1/tenants/{tenantId}/roles')
  async listRoles(@param.path.string('tenantId') tenantId: string): Promise<RoleDto[]> {
    assertScope(this.principal, READ_ROLES); // 403 forbidden_scope if missing
    // Tenant boundary: only your own tenant. Never trust the path for the query.
    if (tenantId !== this.principal.tenantId) throw forbiddenScopeError();
    const defs = await this.roles.list(this.principal.tenantId as TenantId);
    return defs.map(r => ({roleId: r.roleId, name: r.name, scopes: r.scopes}));
  }
}
