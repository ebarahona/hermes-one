// VendorSmsProvider (edge plane): the REAL outbound realization of the messaging.reply.send capability
// against a live SMS vendor. It is the ProviderAdapter the capability resolver picks ahead of the
// internal message-log fallback. Per provider-contracts.md a `*.message.send` capability adapter
// delegates its outbound to the channel transport's `deliver()`; this provider does exactly that, then
// persists the authoritative runtime.messages row (tenant-scoped, RLS, idempotent) with the real vendor
// message id. It returns the capability's UNWRAPPED output (ADR-018 — the ToolResult envelope is
// synthesized by the CapabilityInvoker upstream). A per-provider circuit breaker surfaces through
// status() so the resolver skips the vendor after repeated failures and fails over to the log provider.
//
// FLAGGED (JIT): the breaker state is in-process (one worker instance). A multi-instance deployment
// needs a shared breaker (Redis) — the follow-up owned by redis/idempotency-locks-ratelimits.md. No
// providers/ runtime spec doc exists; this is authored to provider-contracts.md + capability-contracts.md.
import {createHash} from 'node:crypto';
import {
  type ConversationId,
  type IsoTimestamp,
  type ProviderAdapter,
  type ProviderExecutionContext,
  type ProviderStatus,
  type TenantId,
} from '@platform/contracts';
import type {DrizzleMessageRepository} from '@platform-internal/drizzle';
import {MESSAGING_REPLY_SEND, type MessageSendResult, type OutboundInput} from './messaging.js';
import type {ProviderCredentialStore} from '@platform/contracts';
import type {SmsChannelTransport} from './sms-transport.js';

export const TWILIO_SMS_PROVIDER_ID = 'twilio-sms';

export interface CircuitConfig {
  /** Consecutive failures that trip the breaker open (ProviderAdapterConfig.circuit.failureThreshold). */
  failureThreshold: number;
  /** How long the breaker stays open before a half-open trial (ProviderAdapterConfig.circuit.resetMs). */
  resetMs: number;
}

const DEFAULT_CIRCUIT: CircuitConfig = {failureThreshold: 5, resetMs: 30_000};

const shortHash = (s: string, n: number) => createHash('sha256').update(s).digest('hex').slice(0, n);

/** Standard closed → open → half-open breaker over a monotonic clock (ms). */
class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAtMs: number | null = null;

  constructor(private readonly cfg: CircuitConfig, private readonly nowMs: () => number) {}

  /** Reject the call up front when the breaker is open and still cooling down. */
  isOpen(): boolean {
    if (this.openedAtMs === null) return false;
    return this.nowMs() - this.openedAtMs < this.cfg.resetMs;
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAtMs = null;
  }

  onFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.cfg.failureThreshold) this.openedAtMs = this.nowMs();
  }

  state(): 'closed' | 'open' | 'half-open' {
    if (this.openedAtMs === null) return 'closed';
    return this.nowMs() - this.openedAtMs < this.cfg.resetMs ? 'open' : 'half-open';
  }
}

/**
 * Delivers outbound SMS through a vendor transport, persists the authoritative record, and guards the
 * vendor with a circuit breaker. `providerId` matches the capability contract's provider mapping entry.
 */
export class VendorSmsProvider implements ProviderAdapter<OutboundInput, MessageSendResult> {
  readonly providerId = TWILIO_SMS_PROVIDER_ID;
  readonly capability = MESSAGING_REPLY_SEND;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly transport: Pick<SmsChannelTransport, 'deliver'>,
    private readonly repo: DrizzleMessageRepository,
    private readonly credentials: ProviderCredentialStore,
    opts: {circuit?: CircuitConfig; clock?: () => Date; nowMs?: () => number} = {},
  ) {
    this.clock = opts.clock ?? (() => new Date());
    this.breaker = new CircuitBreaker(opts.circuit ?? DEFAULT_CIRCUIT, opts.nowMs ?? (() => Date.now()));
  }

  private readonly clock: () => Date;

  async status(): Promise<ProviderStatus> {
    const circuit = this.breaker.state();
    return {
      providerId: this.providerId,
      health: circuit === 'open' ? 'unavailable' : 'healthy',
      circuit,
      lastCheckedAt: this.clock().toISOString() as IsoTimestamp,
    };
  }

  async execute(input: OutboundInput, ctx: ProviderExecutionContext): Promise<MessageSendResult> {
    // Defense in depth: the resolver already skips an open breaker, but a half-open trial reaching here
    // that we know is still cooling down must not attempt a send.
    if (this.breaker.isOpen()) {
      this.breaker.onFailure();
      throw new Error(`circuit open for ${this.providerId}`);
    }

    const config = (await this.credentials.resolve(ctx.tenantId as TenantId, this.providerId, this.capability)).config;
    const text = input.body ?? input.template ?? '';
    const conversationId = input.conversationId ?? `cnv_${shortHash(input.to, 16)}`;

    let receipt: {providerMessageId: string};
    try {
      receipt = await this.transport.deliver(
        {
          tenantId: ctx.tenantId as TenantId,
          channel: 'sms',
          conversationId: conversationId as ConversationId,
          to: input.to,
          text,
          attachments: [],
          idempotencyKey: ctx.idempotencyKey,
        },
        {...ctx, config},
      );
    } catch (err) {
      this.breaker.onFailure();
      throw err; // classified PlatformErrorException — the invoker maps it to an ok:false ToolResult
    }
    this.breaker.onSuccess();

    // Persist the authoritative outbound record with the REAL vendor id (idempotent on message_id).
    await this.repo.appendOutbound(
      {
        messageId: `msg_${shortHash(ctx.idempotencyKey, 24)}`,
        conversationId,
        channel: 'sms',
        body: text,
        providerMessageId: receipt.providerMessageId,
        status: 'sent',
        occurredAt: this.clock(),
      },
      {tenantId: ctx.tenantId as TenantId},
    );

    return {providerMessageId: receipt.providerMessageId, status: 'sent'};
  }
}
