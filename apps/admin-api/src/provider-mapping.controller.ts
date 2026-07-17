// ProviderMappingController — the tenant provider-mapping OVERRIDE surface (ledger CT3;
// api/capability-and-provider-api.md §ProviderMappingController):
//   GET    /v1/capabilities/{name}/provider-mapping?tenantId=      scope: capability.read
//   PUT    /v1/tenants/{tenantId}/capabilities/{name}/provider-mapping   scope: tenant.providerMapping.write
//   DELETE /v1/tenants/{tenantId}/capabilities/{name}/provider-mapping   scope: tenant.providerMapping.write
// Reads/writes through the RLS-enforced DrizzleProviderMappingRepository. Absence of an override row
// means "use the contract default" (found via findContractDefault over the capability's own published
// contract) — no contract at all is a 404. Fail-closed on scope (assertScope → 403) and the tenant
// boundary (the tenantId in the query/path must equal principal.tenantId, else 403 — same fail-closed
// posture as TenantController).
import {del, get, param, put, requestBody} from '@loopback/rest';
import {inject} from '@loopback/core';
import {z} from 'zod';
import {PlatformBindings} from '@platform-internal/loopback-core';
import {assertScope, forbiddenScopeError} from '@platform-internal/auth';
import type {DrizzleProviderMappingRepository} from '@platform-internal/drizzle';
import {
  type CapabilityName,
  type ErrorIssue,
  PlatformErrorException,
  type Principal,
  type ProviderMapping,
  type Scope,
  type TenantId,
} from '@platform/contracts';

const READ_CAPABILITY = 'capability.read' as Scope;
/** Spec delta (flagged, not improvised): capability-and-provider-api.md writes this scope as
 * `tenant.providerMapping.write` (camelCase). The `Scope` brand (tenant.ts) enforces
 * `^[a-z][a-z0-9-]*(\.[a-z0-9*-]+){1,2}$` — no uppercase — so that literal string fails
 * `Principal.parse` at auth time (every request carrying it would 500, not 403). Using the
 * kebab-case equivalent so the scope is actually grantable/enforceable under this repo's real
 * constraint; same `domain.resource.action` meaning. */
const WRITE_PROVIDER_MAPPING = 'tenant.provider-mapping.write' as Scope;

/** PUT body — mirrors the CapabilityProviderOverride config shape (capability-contracts.md
 * Configuration examples) and capability.provider_mappings columns (database/table-catalog.md). */
export const PutProviderMappingRequest = z.object({
  providers: z.array(z.object({
    providerId: z.string().min(1),
    priority: z.number().int(),
    configKey: z.string().optional(),
  })).min(1),
  eligibility: z.array(z.object({when: z.unknown(), reason: z.string().max(200)})).default([]),
  onNoProvider: z.enum(['fail', 'handoff']).default('fail'),
});
export type PutProviderMappingRequest = z.infer<typeof PutProviderMappingRequest>;

export interface EffectiveProviderMappingResponse {
  source: 'contract-default' | 'tenant-override';
  mapping: ProviderMapping;
  updatedAt?: string; // present only when source === 'tenant-override'
  updatedBy?: string;
}

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

function notFound(name: string): PlatformErrorException {
  return new PlatformErrorException({
    category: 'not-found',
    code: 'not_found',
    message: `no published capability contract: ${name}`,
    issues: [],
    retryable: false,
    httpStatus: 404,
  });
}

export class ProviderMappingController {
  // Spec delta (flagged, not improvised): capability-and-provider-api.md's ProviderMappingController
  // also injects PlatformBindings.CAPABILITY_REGISTRY, but nothing in this controller's routes uses the
  // registry (the contract default is read straight off the tenant's own published contract row via
  // findContractDefault) and CAPABILITY_REGISTRY has no binding in this app's composition root (no
  // CapabilityRegistryComponent is registered here) — injecting it would fail every request with a
  // ResolutionError. Omitted.
  constructor(
    @inject(PlatformBindings.REQUEST_PRINCIPAL) private readonly principal: Principal,
    @inject(PlatformBindings.PROVIDER_MAPPING_REPOSITORY)
    private readonly overrides: DrizzleProviderMappingRepository,
  ) {}

  private assertOwnTenant(tenantId: string, scope: Scope): TenantId {
    assertScope(this.principal, scope); // 403 forbidden_scope if missing
    if (tenantId !== this.principal.tenantId) throw forbiddenScopeError(); // own tenant only
    return this.principal.tenantId as TenantId;
  }

  @get('/v1/capabilities/{name}/provider-mapping') // requiredScope: 'capability.read'; ?tenantId= required
  async getEffective(
    @param.path.string('name') name: CapabilityName,
    @param.query.string('tenantId') tenantId: TenantId,
  ): Promise<EffectiveProviderMappingResponse> {
    const owner = this.assertOwnTenant(tenantId, READ_CAPABILITY);
    const override = await this.overrides.find(owner, name);
    if (override) {
      return {
        source: 'tenant-override',
        mapping: {providers: override.providers, eligibility: override.eligibility, onNoProvider: override.onNoProvider},
        updatedAt: override.updatedAt,
        updatedBy: override.updatedBy,
      };
    }
    const contractDefault = await this.overrides.findContractDefault(owner, name);
    if (!contractDefault) throw notFound(name);
    return {source: 'contract-default', mapping: contractDefault};
  }

  @put('/v1/tenants/{tenantId}/capabilities/{name}/provider-mapping') // requiredScope: WRITE_PROVIDER_MAPPING (see spec-delta note above)
  async put(
    @param.path.string('tenantId') tenantId: TenantId,
    @param.path.string('name') name: CapabilityName,
    @requestBody() body: unknown,
  ): Promise<EffectiveProviderMappingResponse> {
    const owner = this.assertOwnTenant(tenantId, WRITE_PROVIDER_MAPPING);
    const parsed = PutProviderMappingRequest.safeParse(body);
    if (!parsed.success) throw validationFailed(parsed.error);
    const mapping = parsed.data as ProviderMapping;
    await this.overrides.upsert(owner, name, mapping, this.principal.id);
    const stored = await this.overrides.find(owner, name);
    return {
      source: 'tenant-override',
      mapping,
      updatedAt: stored?.updatedAt,
      updatedBy: stored?.updatedBy,
    };
  }

  @del('/v1/tenants/{tenantId}/capabilities/{name}/provider-mapping') // requiredScope: WRITE_PROVIDER_MAPPING (see spec-delta note above)
  async remove(
    @param.path.string('tenantId') tenantId: TenantId,
    @param.path.string('name') name: CapabilityName,
  ): Promise<{reverted: true}> {
    const owner = this.assertOwnTenant(tenantId, WRITE_PROVIDER_MAPPING);
    await this.overrides.remove(owner, name);
    return {reverted: true};
  }
}
