// @platform/contracts — src/provider.ts
import {z} from 'zod';
import {TenantId, ConversationId, IsoTimestamp} from './substrate.js';
import {Channel} from './tenant.js';
import {CapabilityName} from './capability.js';

/* ------------------------- Provider health ----------------------------- */

export const ProviderHealth = z.enum(['healthy', 'degraded', 'unavailable']);
export type ProviderHealth = z.infer<typeof ProviderHealth>;

export const CircuitState = z.enum(['closed', 'open', 'half-open']);
export type CircuitState = z.infer<typeof CircuitState>;

export const ProviderStatus = z.object({
  providerId: z.string().min(1),
  health: ProviderHealth,
  circuit: CircuitState,
  lastCheckedAt: IsoTimestamp,
  detail: z.string().optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

/* ------------------------- ProviderAdapter ----------------------------- */

/** Result mapped to transport-core HandlerResult.outcome (lib-findings) + platform errors. */
export const ProviderOutcome = z.enum([
  'success',
  'handler-error',
  'infrastructure-error',
]);
export type ProviderOutcome = z.infer<typeof ProviderOutcome>;

export interface ProviderExecutionContext {
  tenantId: TenantId;
  capability: CapabilityName;
  idempotencyKey: string;
  /** Secrets resolved from the provider configKey — never logged, never in the contract. */
  config: Readonly<Record<string, string>>;
}

/**
 * Vendor-side realization of ONE capability. Returns the capability's UNWRAPPED output type;
 * the ToolResult envelope is synthesized upstream (ADR-018). `I`/`O` are the capability's Zod-inferred types.
 */
export interface ProviderAdapter<I = unknown, O = unknown> {
  readonly providerId: string;
  readonly capability: CapabilityName;
  status(): Promise<ProviderStatus>;
  execute(input: I, ctx: ProviderExecutionContext): Promise<O>;
}

/* -------------------------- Channel messages --------------------------- */

export const InboundMessage = z.object({
  tenantId: TenantId,
  channel: Channel,
  conversationId: ConversationId.nullable(), // null until conversation resolution
  /** Vendor-neutral sender/recipient handles (phone, wa id, session id, email). */
  from: z.string().min(1),
  to: z.string().min(1),
  text: z.string().optional(),
  attachments: z
    .array(
      z.object({
        kind: z.string(),
        url: z.string(),
        mime: z.string().optional(),
      }),
    )
    .default([]),
  /** Vendor message id for dedupe/receipt correlation. */
  providerMessageId: z.string().min(1),
  receivedAt: IsoTimestamp,
  /** Raw provider metadata (opaque, for audit). */
  providerMeta: z.record(z.string(), z.unknown()).default({}),
});
export type InboundMessage = z.infer<typeof InboundMessage>;

export const OutboundMessage = z.object({
  tenantId: TenantId,
  channel: Channel,
  conversationId: ConversationId,
  to: z.string().min(1),
  text: z.string(),
  attachments: z
    .array(z.object({kind: z.string(), url: z.string()}))
    .default([]),
  /** For WhatsApp: provider-registered template id (data field — findings resolution log). */
  templateId: z.string().optional(),
  idempotencyKey: z.string().min(1),
});
export type OutboundMessage = z.infer<typeof OutboundMessage>;

export const DeliveryReceipt = z.object({
  providerMessageId: z.string().min(1),
  status: z.enum([
    'queued',
    'sent',
    'delivered',
    'read',
    'failed',
    'undelivered',
  ]),
  reason: z.string().optional(),
  at: IsoTimestamp,
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceipt>;

/* -------------------------- ChannelTransport --------------------------- */

/** Marks whether a transport is a stock broker adapter or a custom channel (findings T5). */
export const TransportClass = z.enum(['broker', 'channel']);
export type TransportClass = z.infer<typeof TransportClass>;

/**
 * Bidirectional customer messaging. Broker adapters (Kafka/etc.) ship in transport-core;
 * SMS/WhatsApp/webchat/email/voice are CUSTOM (transportClass='channel') — authored on ServerBase/ClientProxy.
 */
export interface ChannelTransport {
  readonly channel: Channel;
  readonly transportClass: TransportClass; // 'channel' for all custom messaging transports
  /** Verify signature, normalize a raw vendor webhook into an InboundMessage (or null to drop). */
  ingest(
    rawWebhook: unknown,
    headers: Record<string, string>,
  ): Promise<InboundMessage | null>;
  /** Deliver an outbound message; returns the provider message id (receipt is async). */
  deliver(
    msg: OutboundMessage,
    ctx: ProviderExecutionContext,
  ): Promise<{providerMessageId: string}>;
  /** Parse an async delivery-receipt webhook. */
  parseReceipt(
    rawWebhook: unknown,
    headers: Record<string, string>,
  ): Promise<DeliveryReceipt | null>;
  /** Opt-out check + record (STOP/HELP handling). */
  isOptedOut(handle: string, tenantId: TenantId): Promise<boolean>;
}
