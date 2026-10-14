// DefinitionController — authoring the compiled-plan substrate (admin API contract):
//   PUT /v1/definitions/{definitionId}   scope: definition.write
// Upserts a definition of any of the five kinds through DefinitionRegistry.put, which validates the
// body per-kind, compiles the logic-DSL kinds (workflow/rule/policy) or validate-and-pins the
// contract-schema kinds (capability/agent-engine), content-hashes, and stores (idempotent by hash).
// The server derives status/labels/timestamps/createdBy; the client supplies the shaping fields.
// Fail-closed on scope (assertScope → 403) and the tenant boundary (own tenant only; platform-owned
// (tenantId=null) definitions need a privileged path → deferred). The read/validate/compile endpoints
// are follow-ups (DefinitionRegistry is put-only — no read service).
import {inject} from '@loopback/core';
import {param, put, requestBody} from '@loopback/rest';
import {z} from 'zod';
import {PlatformBindings} from '@platform-internal/loopback-core';
import {assertScope, forbiddenScopeError} from '@platform-internal/auth';
import type {DefinitionRegistry, PutDefinitionResult} from '@platform/definition-substrate';
import {
  type Definition,
  DefinitionKind,
  type ErrorIssue,
  PlatformErrorException,
  type Principal,
  type PrincipalId,
  type Scope,
  SemVer,
} from '@platform/contracts';

const WRITE_DEF = 'definition.write' as Scope;

/** PutDefinitionRequest — the shaping fields; the body is narrowed per-kind by the registry. */
const PutDefinitionRequest = z.object({
  tenantId: z.string().nullable(),
  kind: DefinitionKind,
  name: z.string().min(1).max(128),
  schemaRef: z.string(),
  version: SemVer,
  body: z.unknown(),
});

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

export class DefinitionController {
  constructor(
    @inject(PlatformBindings.REQUEST_PRINCIPAL) private readonly principal: Principal,
    @inject(PlatformBindings.DEFINITION_REGISTRY) private readonly registry: DefinitionRegistry,
  ) {}

  @put('/v1/definitions/{definitionId}')
  async putDefinition(
    @param.path.string('definitionId') definitionId: string,
    @requestBody({content: {'application/json': {schema: {type: 'object', additionalProperties: true}}}})
    body: unknown,
  ): Promise<PutDefinitionResult> {
    assertScope(this.principal, WRITE_DEF); // 403 forbidden_scope if missing
    const parsed = PutDefinitionRequest.safeParse(body);
    if (!parsed.success) {
      throw validationFailed(parsed.error.issues.map(i => ({path: `/${i.path.join('/')}`, message: i.message})));
    }
    const req = parsed.data;
    // Own tenant only; platform-owned (tenantId=null) authoring needs a privileged path (deferred).
    if (req.tenantId !== this.principal.tenantId) throw forbiddenScopeError();

    const now = new Date().toISOString();
    const def = {
      definitionId,
      tenantId: req.tenantId,
      kind: req.kind,
      name: req.name,
      schemaRef: req.schemaRef,
      version: req.version,
      status: 'draft',
      labels: {},
      createdAt: now,
      updatedAt: now,
      createdBy: this.principal.id,
      body: req.body,
    } as unknown as Definition;

    try {
      return await this.registry.put(def, this.principal.id as PrincipalId);
    } catch (err) {
      if (err instanceof PlatformErrorException) throw err;
      // Per-kind validation / compile failure → 422 (the authenticated author sees the reason).
      throw validationFailed([{path: '/body', message: String((err as Error).message).slice(0, 300)}]);
    }
  }
}
