// DeploymentController — the tenant's deployment read surface (api/admin-api.md §DeploymentController):
//   GET /v1/deployments/active?tenantId=…        scope: deployment.read
//   GET /v1/deployments/{tenantId}/{version}      scope: deployment.read
// Reads through the DeploymentService, whose resolveActive/resolveVersion delegate to the
// content-addressed store and self-scope by tenant (RLS). Fail-closed on scope (assertScope → 403)
// and the tenant boundary (own tenant only; the query always uses the TRUSTED principal.tenantId,
// never the path/query). A tenant with no matching deployment → the store throws not_found → 404.
// Publish/rollback (writes) + the cross-tenant/platform-operator listing are later slices.
import {inject} from '@loopback/core';
import {get, param} from '@loopback/rest';
import {PlatformBindings} from '@platform-internal/loopback-core';
import {assertScope, forbiddenScopeError} from '@platform-internal/auth';
import type {DeploymentService} from '@platform/definition-substrate';
import type {Deployment, Principal, Scope, SemVer, TenantId} from '@platform/contracts';

const READ_DEPLOYMENTS = 'deployment.read' as Scope;

export class DeploymentController {
  constructor(
    @inject(PlatformBindings.REQUEST_PRINCIPAL) private readonly principal: Principal,
    @inject(PlatformBindings.DEPLOYMENT_SERVICE) private readonly deployments: DeploymentService,
  ) {}

  private assertOwnTenant(tenantId: string): TenantId {
    assertScope(this.principal, READ_DEPLOYMENTS); // 403 forbidden_scope if missing
    if (tenantId !== this.principal.tenantId) throw forbiddenScopeError(); // never trust the path/query
    return this.principal.tenantId as TenantId;
  }

  @get('/v1/deployments/active')
  async active(@param.query.string('tenantId') tenantId: string): Promise<Deployment> {
    const owner = this.assertOwnTenant(tenantId);
    return this.deployments.resolveActive(owner); // not_found → 404
  }

  @get('/v1/deployments/{tenantId}/{version}')
  async byVersion(
    @param.path.string('tenantId') tenantId: string,
    @param.path.string('version') version: string,
  ): Promise<Deployment> {
    const owner = this.assertOwnTenant(tenantId);
    return this.deployments.resolveVersion(owner, version as SemVer); // not_found → 404
  }
}
