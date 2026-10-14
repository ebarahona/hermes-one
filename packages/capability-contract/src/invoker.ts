// The real capability invocation path (replaces the console.log stub): resolve the capability's
// contract, pick a provider (ranked/eligible/healthy), execute the ProviderAdapter, and synthesize the
// rich ToolResult envelope (ADR-018) — sideEffect/changedDomains/stateChanged come from the contract
// metadata, evidence + metrics from the dispatch. A NoProviderError propagates so the caller maps
// onNoProvider to fail-vs-handoff; a provider execution failure becomes an ok:false ToolResult.
import {
  PlatformErrorException,
  ToolResult,
  type CapabilityContract,
  type CapabilityName,
  type ProviderMapping,
  type EvidenceId,
  type EvidenceRecord,
  type IsoTimestamp,
  type TenantId,
  type ToolCall,
  type TurnId,
} from '@platform/contracts';
import type {ProviderResolver} from './resolver.js';

const MUTATING = new Set(['write', 'external', 'payment']);

export interface InvokeContext {
  turnId: TurnId;
  tenantId: TenantId;
  /** Tenant-runtime facts the provider resolver evaluates eligibility against. */
  facts: Record<string, unknown>;
  /** Observation timestamp for synthesized evidence (the activity's clock). */
  now: IsoTimestamp;
  /** Static bundle fallback (legacy call sites). Superseded by providerConfigFor when present. */
  providerConfig: Readonly<Record<string, string>>;
  /**
   * Resolves the chosen provider's credential bundle per (tenant, provider, capability) — the
   * ProviderCredentialStore chain (ADR-026). Called AFTER ranking, because only then is the
   * providerId known. Fail-closed at the store; a credential-less internal provider is an
   * explicit `{}` bundle. Never logged.
   */
  providerConfigFor?: (providerId: string) => Promise<Readonly<Record<string, string>>>;
}

/** Looks up the pinned CapabilityContract for a name (from the active deployment's manifest). */
export type CapabilityLookup = (name: CapabilityName) => CapabilityContract | undefined;

/**
 * Looks up the TENANT's provider-mapping override (capability.provider_mappings — CT3). Absence of a
 * row means "use the contract's default". The contract itself is immutable and
 * content-hashed; the override is plain tenant-row CRUD, which is exactly why it is consulted at
 * INVOCATION time rather than baked into the pinned contract.
 */
export type ProviderMappingOverrideLookup = (
  tenantId: TenantId,
  capability: CapabilityName,
) => Promise<ProviderMapping | null>;

export class CapabilityInvoker {
  constructor(
    private readonly lookup: CapabilityLookup,
    private readonly resolver: ProviderResolver,
    private readonly mappingOverride?: ProviderMappingOverrideLookup,
  ) {}

  async invoke(call: ToolCall, ctx: InvokeContext): Promise<ToolResult> {
    const contract = this.lookup(call.capability);
    if (!contract) {
      return this.errorResult(call, contract, 'not_found', `unknown capability: ${call.capability}`);
    }

    // Tenant override first (CT3), contract default otherwise — then resolve() ranks within the
    // EFFECTIVE mapping. resolve() throws NoProviderError (fail/handoff) — propagated by design.
    const mapping = (await this.mappingOverride?.(ctx.tenantId, call.capability)) ?? contract.providerMapping;
    const provider = await this.resolver.resolve(call.capability, mapping, ctx.facts);

    const started = Date.now();
    try {
      const config = ctx.providerConfigFor ? await ctx.providerConfigFor(provider.providerId) : ctx.providerConfig;
      const output = await provider.execute(call.input, {
        tenantId: ctx.tenantId,
        capability: call.capability,
        idempotencyKey: call.idempotencyKey,
        config,
      });
      return ToolResult.parse({
        toolCallId: call.toolCallId,
        capability: call.capability,
        ok: true,
        output,
        sideEffect: contract.sideEffect,
        stateChanged: MUTATING.has(contract.sideEffect),
        changedDomains: contract.changedDomains,
        evidence: [this.evidenceOf(call, output, provider.providerId, ctx)],
        metrics: {
          latencyMs: Date.now() - started,
          providerId: provider.providerId,
          retries: 0,
          costUsd: 0,
          idempotentReplay: false,
        },
        error: null,
      });
    } catch (err) {
      // A provider that throws a classified PlatformErrorException carries the real code/retryable
      // (e.g. vendor 5xx → infrastructure_error retryable); a plain Error defaults to a non-retryable
      // business rejection.
      const pe = err instanceof PlatformErrorException ? err.error : undefined;
      const e = err as {code?: string; message?: string; retryable?: boolean};
      return this.errorResult(
        call,
        contract,
        pe?.code ?? e.code ?? 'provider_rejected',
        pe?.message ?? e.message ?? String(err),
        pe?.retryable ?? e.retryable ?? false,
        provider.providerId,
        Date.now() - started,
      );
    }
  }

  private evidenceOf(
    call: ToolCall,
    output: unknown,
    providerId: string,
    ctx: InvokeContext,
  ): EvidenceRecord {
    const data =
      output && typeof output === 'object' && !Array.isArray(output)
        ? (output as Record<string, unknown>)
        : {value: output};
    return {
      id: `evd_${call.toolCallId}` as EvidenceId,
      turnId: ctx.turnId,
      toolCallId: call.toolCallId,
      kind: 'tool-output',
      capability: call.capability,
      statement: `${call.capability} via ${providerId} returned a result`,
      data,
      // ADR-028: a schema-validated result from a capability the platform authored, gated, and
      // invoked is authoritative/trusted — `trusted:false` is the RETRIEVED-content injection
      // defense. This aligns with the agent plane's envelope hook and the canonical example in
      // ADR-009 composition grounds only on trusted.
      source: 'authoritative',
      trusted: true,
      observedAt: ctx.now,
    };
  }

  private errorResult(
    call: ToolCall,
    contract: CapabilityContract | undefined,
    code: string,
    message: string,
    retryable = false,
    providerId?: string,
    latencyMs = 0,
  ): ToolResult {
    return ToolResult.parse({
      toolCallId: call.toolCallId,
      capability: call.capability,
      ok: false,
      output: null,
      sideEffect: contract?.sideEffect ?? 'read',
      stateChanged: false,
      changedDomains: [],
      evidence: [],
      metrics: {latencyMs, providerId, retries: 0, costUsd: 0, idempotentReplay: false},
      error: {code, message, retryable},
    });
  }
}
