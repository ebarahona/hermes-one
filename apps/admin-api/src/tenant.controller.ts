// TenantController — the tenant self-service surface (admin API contract):
//   GET   /v1/tenants/{tenantId}   scope: platform.tenant.read     tenant-scoped read
//   PATCH /v1/tenants/{tenantId}   scope: platform.tenant.update    tenant-scoped write
// Reads/updates the caller's OWN tenant row through the RLS-enforced DrizzleTenantRepository. The
// cross-tenant operator routes (POST/GET /v1/tenants — platform.tenant.create/list) are DEFERRED on
// the RLS relay-role posture. Fail-closed on scope (assertScope → 403) and the tenant boundary
// (path must equal principal.tenantId → else 403; a missing row → the repo throws not_found → 404).
import {inject} from '@loopback/core';
import {get, param, patch, requestBody} from '@loopback/rest';
import {z} from 'zod';
import {PlatformBindings} from '@hermes-one/loopback-core';
import {tenantConfigChangedEvent} from './audit-events.js';
import {assertScope, forbiddenScopeError} from '@hermes-one/auth';
import type {DrizzleTenantRepository} from '@hermes-one/drizzle';
import {
  type ErrorIssue,
  PlatformErrorException,
  type Principal,
  type Scope,
  type TenantContext,
  TenantStatus,
  type TenantId,
} from '@hermes-one/contracts';

const READ_TENANT = 'platform.tenant.read' as Scope;
const UPDATE_TENANT = 'platform.tenant.update' as Scope;

/** UpdateTenantRequest — the mutable subset of a tenant. */
const UpdateTenantRequest = z.object({
  displayName: z.string().max(200).optional(),
  status: TenantStatus.optional(),
  features: z.record(z.string(), z.boolean()).optional(),
});

function validationFailed(err: z.ZodError): PlatformErrorException {
  const issues: ErrorIssue[] = err.issues.map(i => ({
    path: `/${i.path.join('/')}`,
    message: i.message,
  }));
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
    @inject(PlatformBindings.REQUEST_PRINCIPAL)
    private readonly principal: Principal,
    @inject(PlatformBindings.TENANT_REPOSITORY)
    private readonly tenants: DrizzleTenantRepository,
    @inject(PlatformBindings.CORRELATION_ID)
    private readonly correlationId: string,
  ) {}

  private assertOwnTenant(tenantId: string, scope: Scope): TenantId {
    assertScope(this.principal, scope); // 403 forbidden_scope if missing
    if (tenantId !== this.principal.tenantId) throw forbiddenScopeError(); // own tenant only
    return this.principal.tenantId as TenantId;
  }

  @get('/v1/tenants/{tenantId}')
  async getTenant(
    @param.path.string('tenantId') tenantId: string,
  ): Promise<TenantContext> {
    const owner = this.assertOwnTenant(tenantId, READ_TENANT);
    return this.tenants.getTenant(owner); // not_found → 404
  }

  @patch('/v1/tenants/{tenantId}')
  async updateTenant(
    @param.path.string('tenantId') tenantId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {type: 'object', additionalProperties: true},
        },
      },
    })
    body: unknown,
  ): Promise<TenantContext> {
    const owner = this.assertOwnTenant(tenantId, UPDATE_TENANT);
    const parsed = UpdateTenantRequest.safeParse(body);
    if (!parsed.success) throw validationFailed(parsed.error);
    // tenant.config.changed rides the update's OWN transaction (commit-and-publish, AU4). Field NAMES
    // only in the detail — values may carry PII/plan data.
    const event = tenantConfigChangedEvent({
      tenantId: owner,
      actor: this.principal.id,
      correlationId: this.correlationId,
      changedFields: Object.keys(parsed.data).sort(),
      occurredAt: new Date().toISOString() as never,
    });
    return this.tenants.updateTenant(owner, parsed.data, [event]); // not_found → 404
  }
}
