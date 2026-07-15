// TenantController — the tenant self-service surface (api/admin-api.md §TenantController):
//   GET   /v1/tenants/{tenantId}   scope: platform.tenant.read     tenant-scoped read
//   PATCH /v1/tenants/{tenantId}   scope: platform.tenant.update    tenant-scoped write
// Reads/updates the caller's OWN tenant row through the RLS-enforced DrizzleTenantRepository. The
// cross-tenant operator routes (POST/GET /v1/tenants — platform.tenant.create/list) are DEFERRED on
// the RLS relay-role posture. Fail-closed on scope (assertScope → 403) and the tenant boundary
// (path must equal principal.tenantId → else 403; a missing row → the repo throws not_found → 404).
import {inject} from '@loopback/core';
import {get, param, patch, requestBody} from '@loopback/rest';
import {z} from 'zod';
import {PlatformBindings} from '@platform-internal/loopback-core';
import {assertScope, forbiddenScopeError} from '@platform-internal/auth';
import type {DrizzleTenantRepository} from '@platform-internal/drizzle';
import {
  type ErrorIssue,
  PlatformErrorException,
  type Principal,
  type Scope,
  type TenantContext,
  TenantStatus,
  type TenantId,
} from '@platform/contracts';

const READ_TENANT = 'platform.tenant.read' as Scope;
const UPDATE_TENANT = 'platform.tenant.update' as Scope;

/** admin-api.md UpdateTenantRequest — the mutable subset of a tenant. */
const UpdateTenantRequest = z.object({
  displayName: z.string().max(200).optional(),
  status: TenantStatus.optional(),
  features: z.record(z.string(), z.boolean()).optional(),
});

function validationFailed(err: z.ZodError): PlatformErrorException {
  const issues: ErrorIssue[] = err.issues.map(i => ({path: `/${i.path.join('/')}`, message: i.message}));
  return new PlatformErrorException({
    category: 'validation',
    code: 'validation_failed',
    message: 'Input failed schema validation.',
    issues,
    retryable: false,
    httpStatus: 422,
  });
}

export class TenantController {
  constructor(
    @inject(PlatformBindings.REQUEST_PRINCIPAL) private readonly principal: Principal,
    @inject(PlatformBindings.TENANT_REPOSITORY) private readonly tenants: DrizzleTenantRepository,
  ) {}

  private assertOwnTenant(tenantId: string, scope: Scope): TenantId {
    assertScope(this.principal, scope); // 403 forbidden_scope if missing
    if (tenantId !== this.principal.tenantId) throw forbiddenScopeError(); // own tenant only
    return this.principal.tenantId as TenantId;
  }

  @get('/v1/tenants/{tenantId}')
  async getTenant(@param.path.string('tenantId') tenantId: string): Promise<TenantContext> {
    const owner = this.assertOwnTenant(tenantId, READ_TENANT);
    return this.tenants.getTenant(owner); // not_found → 404
  }

  @patch('/v1/tenants/{tenantId}')
  async updateTenant(
    @param.path.string('tenantId') tenantId: string,
    @requestBody({content: {'application/json': {schema: {type: 'object', additionalProperties: true}}}})
    body: unknown,
  ): Promise<TenantContext> {
    const owner = this.assertOwnTenant(tenantId, UPDATE_TENANT);
    const parsed = UpdateTenantRequest.safeParse(body);
    if (!parsed.success) throw validationFailed(parsed.error);
    return this.tenants.updateTenant(owner, parsed.data); // not_found → 404
  }
}
