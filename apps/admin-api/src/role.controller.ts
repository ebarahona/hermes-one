// RoleController — the tenant role resource (admin API contract):
//   GET  /v1/tenants/{tenantId}/roles   scope: tenant.role.read     tenant-scoped read
//   POST /v1/tenants/{tenantId}/roles   scope: tenant.role.create   tenant-scoped write
// Both read/write through the tenant-scoped, RLS-enforced DrizzleRoleRegistry (opens the tenant GUC
// per call). Fail-closed on BOTH axes: the scope gate (assertScope → 403 forbidden_scope) and the
// tenant boundary (a principal only touches its OWN tenant — path/principal mismatch → 403; writes
// always use the TRUSTED principal.tenantId, never the path or body).
import {inject} from '@loopback/core';
import {get, param, post, requestBody, RestBindings, type Response} from '@loopback/rest';
import {z} from 'zod';
import {PlatformBindings} from '@platform-internal/loopback-core';
import {assertScope, forbiddenScopeError} from '@platform-internal/auth';
import {type ErrorIssue, PlatformErrorException, type Principal, type RoleRegistry, type Scope, type TenantId} from '@platform/contracts';

const READ_ROLES = 'tenant.role.read' as Scope;
const CREATE_ROLES = 'tenant.role.create' as Scope;

/** Request body (`CreateRoleRequest`). tenantId is NEVER taken from the
 *  body — it is the trusted principal's tenant. */
const CreateRoleRequest = z.object({
  name: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  description: z.string().optional(),
});

/** Response shape (plain array, no pagination). */
export interface RoleDto {
  roleId: string;
  name: string;
  scopes: string[];
}

/** Map a ZodError to a 422 `validation_failed` PlatformError (per-field issues, no internals leaked). */
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

function conflict(message: string): PlatformErrorException {
  return new PlatformErrorException({
    category: 'conflict',
    code: 'idempotency_conflict', // closest fixed code; the taxonomy has no dedicated already-exists
    message,
    issues: [],
    retryable: false,
    httpStatus: 409,
  });
}

export class RoleController {
  constructor(
    @inject(PlatformBindings.REQUEST_PRINCIPAL) private readonly principal: Principal,
    @inject(PlatformBindings.ROLE_REGISTRY) private readonly roles: RoleRegistry,
  ) {}

  @get('/v1/tenants/{tenantId}/roles')
  async listRoles(@param.path.string('tenantId') tenantId: string): Promise<RoleDto[]> {
    assertScope(this.principal, READ_ROLES); // 403 forbidden_scope if missing
    if (tenantId !== this.principal.tenantId) throw forbiddenScopeError(); // never trust the path
    const defs = await this.roles.list(this.principal.tenantId as TenantId);
    return defs.map(r => ({roleId: r.roleId, name: r.name, scopes: r.scopes}));
  }

  @post('/v1/tenants/{tenantId}/roles')
  async createRole(
    @param.path.string('tenantId') tenantId: string,
    @requestBody({content: {'application/json': {schema: {type: 'object', additionalProperties: true}}}})
    body: unknown,
    @inject(RestBindings.Http.RESPONSE) response: Response,
  ): Promise<RoleDto> {
    assertScope(this.principal, CREATE_ROLES); // 403 forbidden_scope if missing
    if (tenantId !== this.principal.tenantId) throw forbiddenScopeError();
    const parsed = CreateRoleRequest.safeParse(body);
    if (!parsed.success) throw validationFailed(parsed.error);

    const owner = this.principal.tenantId as TenantId; // trusted — never the path/body
    if (await this.roles.get(owner, parsed.data.name)) {
      throw conflict('A role with this name already exists for the tenant.');
    }
    const created = await this.roles.create({
      tenantId: owner,
      name: parsed.data.name,
      scopes: parsed.data.scopes as Scope[],
      description: parsed.data.description,
    });
    response.status(201);
    return {roleId: created.roleId, name: created.name, scopes: created.scopes};
  }
}
