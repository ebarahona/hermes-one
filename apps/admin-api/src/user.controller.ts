// UserController — the tenant user/principal resource (admin API contract):
//   POST /v1/tenants/{tenantId}/users   scope: tenant.user.create   tenant-scoped write
//   GET  /v1/tenants/{tenantId}/users   scope: tenant.user.read      tenant-scoped read
// Read/write through the RLS-enforced DrizzleUserRepository (own tenant only). Fail-closed on scope
// (assertScope → 403) and the tenant boundary (path must equal principal.tenantId → else 403; writes
// use the TRUSTED principal.tenantId). A per-tenant email/handle/identity collision → 409.
//
// Flagged: the list returns a full PageResponse envelope but cursor pagination is not implemented
// (all users in one page) — the cursor logic lands with the shared pagination helper.
import {inject} from '@loopback/core';
import {
  get,
  param,
  post,
  requestBody,
  RestBindings,
  type Response,
} from '@loopback/rest';
import {z} from 'zod';
import {PlatformBindings} from '@hermes-one/loopback-core';
import {assertScope, forbiddenScopeError} from '@hermes-one/auth';
import type {DrizzleUserRepository, UserDto} from '@hermes-one/drizzle';
import {
  type ErrorIssue,
  PlatformErrorException,
  type Principal,
  type Scope,
  type TenantId,
} from '@hermes-one/contracts';

const CREATE_USER = 'tenant.user.create' as Scope;
const READ_USER = 'tenant.user.read' as Scope;

/** CreateUserRequest — the mutable subset (server derives principalId/status/timestamps). */
const CreateUserRequest = z.object({
  kind: z.enum(['user', 'service', 'system']),
  displayName: z.string().optional(),
  email: z.string().email().optional(),
  externalHandle: z.string().optional(),
  roleNames: z.array(z.string()).default([]),
  attributes: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .default({}),
});

interface PageResponse<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

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

export class UserController {
  constructor(
    @inject(PlatformBindings.REQUEST_PRINCIPAL)
    private readonly principal: Principal,
    @inject(PlatformBindings.USER_REPOSITORY)
    private readonly users: DrizzleUserRepository,
  ) {}

  private assertOwnTenant(tenantId: string, scope: Scope): TenantId {
    assertScope(this.principal, scope); // 403 forbidden_scope if missing
    if (tenantId !== this.principal.tenantId) throw forbiddenScopeError();
    return this.principal.tenantId as TenantId;
  }

  @post('/v1/tenants/{tenantId}/users')
  async createUser(
    @param.path.string('tenantId') tenantId: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {type: 'object', additionalProperties: true},
        },
      },
    })
    body: unknown,
    @inject(RestBindings.Http.RESPONSE) response: Response,
  ): Promise<UserDto> {
    const owner = this.assertOwnTenant(tenantId, CREATE_USER);
    const parsed = CreateUserRequest.safeParse(body);
    if (!parsed.success) throw validationFailed(parsed.error);
    const dto = await this.users.createUser(owner, parsed.data); // 23505 → 409
    response.status(201);
    return dto;
  }

  @get('/v1/tenants/{tenantId}/users')
  async listUsers(
    @param.path.string('tenantId') tenantId: string,
  ): Promise<PageResponse<UserDto>> {
    const owner = this.assertOwnTenant(tenantId, READ_USER);
    const items = await this.users.listUsers(owner);
    return {items, nextCursor: null, hasMore: false}; // cursor paging simplified (flagged)
  }
}
