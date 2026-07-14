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
  /** Secrets resolved from the chosen provider's configKey — never logged, never in the contract. */
  providerConfig: Readonly<Record<string, string>>;
}

/** Looks up the pinned CapabilityContract for a name (from the active deployment's manifest). */
export type CapabilityLookup = (name: CapabilityName) => CapabilityContract | undefined;

export class CapabilityInvoker {
  constructor(
    private readonly lookup: CapabilityLookup,
    private readonly resolver: ProviderResolver,
  ) {}

  async invoke(call: ToolCall, ctx: InvokeContext): Promise<ToolResult> {
    const contract = this.lookup(call.capability);
    if (!contract) {
      return this.errorResult(call, contract, 'not_found', `unknown capability: ${call.capability}`);
    }

    // resolve() throws NoProviderError (fail/handoff) — propagated to the caller by design.
    const provider = await this.resolver.resolve(call.capability, contract.providerMapping, ctx.facts);

    const started = Date.now();
    try {
      const output = await provider.execute(call.input, {
        tenantId: ctx.tenantId,
        capability: call.capability,
        idempotencyKey: call.idempotencyKey,
        config: ctx.providerConfig,
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
      source: 'provider',
      trusted: false,
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
