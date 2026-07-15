// DeploymentController — the tenant's deployment surface (api/admin-api.md §DeploymentController):
//   GET  /v1/deployments/active?tenantId=…        scope: deployment.read
//   GET  /v1/deployments/{tenantId}/{version}      scope: deployment.read
//   POST /v1/deployments/preview                   scope: deployment.publish  (validate, no write)
//   POST /v1/deployments                            scope: deployment.publish  (publish → new version)
//   POST /v1/deployments/{tenantId}/rollback        scope: deployment.publish
// Reads/writes through the DeploymentService, self-scoped by tenant (RLS). Fail-closed on scope
// (assertScope → 403) and the tenant boundary (own tenant only; the manifest's tenantId + actor are
// ALWAYS the trusted principal, never the body/path). A missing deployment → store not_found → 404.
// The cross-tenant/platform-operator listing stays deferred on the relay-role posture.
import {inject} from '@loopback/core';
import {get, param, post, requestBody} from '@loopback/rest';
import {z} from 'zod';
import {PlatformBindings} from '@platform-internal/loopback-core';
import {assertScope, forbiddenScopeError} from '@platform-internal/auth';
import type {DeploymentService, DeploymentValidation, PublishDeploymentInput} from '@platform/definition-substrate';
import {
  type Deployment,
  type DeploymentMember,
  type DeploymentRef,
  type ErrorIssue,
  PlatformErrorException,
  type Principal,
  type PrincipalId,
  type Scope,
  SemVer,
  type TenantId,
} from '@platform/contracts';

const READ_DEPLOYMENTS = 'deployment.read' as Scope;
const PUBLISH_DEPLOYMENTS = 'deployment.publish' as Scope;

/** A manifest pick — the fields of a DeploymentMember (admin-api.md PickDto). */
const PickDto = z.object({
  kind: z.enum(['workflow', 'rule', 'policy', 'capability', 'agent-engine']),
  definitionId: z.string(),
  planId: z.string().nullable(),
  version: SemVer,
  contentHash: z.string(),
});

const DeploymentPublishRequest = z.object({
  tenantId: z.string(),
  workflow: PickDto,
  agentEngine: PickDto,
  policy: PickDto,
  rules: z.array(PickDto).default([]),
  capabilities: z.array(PickDto).default([]),
  operatorRegistryVersion: SemVer,
  notes: z.string().max(2000).optional(),
});

const RollbackRequest = z.object({toVersion: SemVer});

function validationFailed(issues: ErrorIssue[]): PlatformErrorException {
  return new PlatformErrorException({
    category: 'validation',
    code: 'validation_failed',
    message: 'Input failed schema validation.',
    issues,
    retryable: false,
    httpStatus: 422,
  });
}

export class DeploymentController {
  constructor(
    @inject(PlatformBindings.REQUEST_PRINCIPAL) private readonly principal: Principal,
    @inject(PlatformBindings.DEPLOYMENT_SERVICE) private readonly deployments: DeploymentService,
  ) {}

  private assertOwnTenant(tenantId: string, scope: Scope): TenantId {
    assertScope(this.principal, scope); // 403 forbidden_scope if missing
    if (tenantId !== this.principal.tenantId) throw forbiddenScopeError(); // never trust the path/query/body
    return this.principal.tenantId as TenantId;
  }

  /** Build the service input from a validated request — tenantId + actor are ALWAYS the trusted principal. */
  private toInput(owner: TenantId, req: z.infer<typeof DeploymentPublishRequest>): PublishDeploymentInput {
    const member = (p: z.infer<typeof PickDto>): DeploymentMember => p as DeploymentMember;
    return {
      tenantId: owner,
      workflow: member(req.workflow),
      agentEngine: member(req.agentEngine),
      policy: member(req.policy),
      rules: req.rules.map(member),
      capabilities: req.capabilities.map(member),
      operatorRegistryVersion: req.operatorRegistryVersion,
      actor: this.principal.id as PrincipalId,
      notes: req.notes,
    };
  }

  private parseManifest(owner: TenantId, body: unknown): PublishDeploymentInput {
    const parsed = DeploymentPublishRequest.safeParse(body);
    if (!parsed.success) {
      throw validationFailed(parsed.error.issues.map(i => ({path: `/${i.path.join('/')}`, message: i.message})));
    }
    if (parsed.data.tenantId !== owner) throw forbiddenScopeError(); // manifest tenant must be your own
    return this.toInput(owner, parsed.data);
  }

  @get('/v1/deployments/active')
  async active(@param.query.string('tenantId') tenantId: string): Promise<Deployment> {
    const owner = this.assertOwnTenant(tenantId, READ_DEPLOYMENTS);
    return this.deployments.resolveActive(owner); // not_found → 404
  }

  @get('/v1/deployments/{tenantId}/{version}')
  async byVersion(
    @param.path.string('tenantId') tenantId: string,
    @param.path.string('version') version: string,
  ): Promise<Deployment> {
    const owner = this.assertOwnTenant(tenantId, READ_DEPLOYMENTS);
    return this.deployments.resolveVersion(owner, version as SemVer); // not_found → 404
  }

  @post('/v1/deployments/preview')
  async preview(
    @requestBody({content: {'application/json': {schema: {type: 'object', additionalProperties: true}}}})
    body: unknown,
  ): Promise<DeploymentValidation> {
    // The manifest's own tenantId gates the boundary; the scope is checked first.
    assertScope(this.principal, PUBLISH_DEPLOYMENTS);
    const owner = this.principal.tenantId as TenantId;
    const input = this.parseManifest(owner, body);
    return this.deployments.validateManifest(input); // ok:true|false — a 200 either way (no write)
  }

  @post('/v1/deployments')
  async publish(
    @requestBody({content: {'application/json': {schema: {type: 'object', additionalProperties: true}}}})
    body: unknown,
  ): Promise<DeploymentRef> {
    assertScope(this.principal, PUBLISH_DEPLOYMENTS);
    const owner = this.principal.tenantId as TenantId;
    const input = this.parseManifest(owner, body);
    try {
      return await this.deployments.publish(input); // Idempotency-Key not enforced yet (flagged)
    } catch (err) {
      if (err instanceof PlatformErrorException) throw err;
      throw validationFailed([{path: '/manifest', message: String((err as Error).message).slice(0, 300)}]);
    }
  }

  @post('/v1/deployments/{tenantId}/rollback')
  async rollback(
    @param.path.string('tenantId') tenantId: string,
    @requestBody({content: {'application/json': {schema: {type: 'object', additionalProperties: true}}}})
    body: unknown,
  ): Promise<DeploymentRef> {
    const owner = this.assertOwnTenant(tenantId, PUBLISH_DEPLOYMENTS);
    const parsed = RollbackRequest.safeParse(body);
    if (!parsed.success) throw validationFailed([{path: '/toVersion', message: 'a valid SemVer is required'}]);
    return this.deployments.rollback(owner, parsed.data.toVersion, this.principal.id as PrincipalId);
  }
}
