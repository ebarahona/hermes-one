// The capability-node side effect as a real Temporal activity (replaces the console.log stub). It
// derives the idempotency key from the pinned contract, builds a ToolCall, and runs it through the
// CapabilityInvoker (resolve provider → execute → ToolResult). The worker composition root wires the
// registry/resolver/invoker + concrete providers; this activity depends only on the injected invoker.
import {createHash} from 'node:crypto';
import {
  CapabilityInvoker,
  deriveIdempotencyKey,
  type CapabilityLookup,
} from '@platform/capability-contract';
import type {
  CapabilityName,
  IsoTimestamp,
  ProviderCredentialStore,
  TenantId,
  ToolCallId,
  TurnId,
} from '@platform/contracts';

const short = (s: string, n: number) => createHash('sha256').update(s).digest('hex').slice(0, n);

export interface InvokeCapabilityArgs {
  capability: string;
  input: Record<string, unknown>;
  tenantId: string;
  correlationId: string;
}

export function createCapabilityActivities(
  invoker: CapabilityInvoker,
  lookup: CapabilityLookup,
  credentials?: ProviderCredentialStore,
) {
  return {
    async invokeCapability(a: InvokeCapabilityArgs): Promise<{
      delivered: boolean;
      capability: string;
      ok: boolean;
      providerMessageId?: string;
    }> {
      const contract = lookup(a.capability as CapabilityName);
      if (!contract) throw new Error(`unknown capability: ${a.capability}`);

      const turnId = `trn_${short(a.correlationId, 24)}` as TurnId;
      const idempotencyKey = deriveIdempotencyKey(contract, a.input, turnId);
      const now = new Date().toISOString() as IsoTimestamp;

      const result = await invoker.invoke(
        {
          toolCallId: `tc_${short(idempotencyKey, 16)}` as ToolCallId,
          capability: a.capability as CapabilityName,
          input: a.input,
          idempotencyKey,
          proposedAt: now,
        },
        {
          turnId,
          tenantId: a.tenantId as TenantId,
          facts: {},
          now,
          providerConfig: {},
          // PE7 (edge half): credentials resolve per (tenant, provider, capability) once ranking
          // picks the adapter. Absent store → legacy {} (VendorSmsProvider still self-resolves —
          // convergence onto this seam rides the ADR-026 envelope store, flagged S7).
          ...(credentials
            ? {
                providerConfigFor: async (providerId: string) =>
                  (await credentials.resolve(a.tenantId as TenantId, providerId, a.capability as CapabilityName)).config,
              }
            : {}),
        },
      );

      const output = result.output as {providerMessageId?: string} | null;
      return {
        delivered: result.ok,
        capability: a.capability,
        ok: result.ok,
        providerMessageId: output?.providerMessageId,
      };
    },
  };
}
