// The messaging.reply.send capability + an internal message-log provider (edge plane). The provider is
// the real outbound side effect: it persists an OutboundMessage row to runtime.messages (tenant-scoped,
// idempotent), replacing the invokeCapability console.log. A vendor SMS/WhatsApp adapter is a later swap
// behind the same ProviderAdapter port. NOTE: this contract is authored JIT against the capability and provider contracts.
import {createHash} from 'node:crypto';
import {
  CapabilityContract,
  type CapabilityName,
  type IsoTimestamp,
  type ProviderAdapter,
  type ProviderExecutionContext,
  type ProviderStatus,
  type TenantId,
} from '@platform/contracts';
import type {DrizzleMessageRepository} from '@platform-internal/drizzle';

export const MESSAGING_REPLY_SEND = 'messaging.reply.send' as CapabilityName;

/** The messaging.reply.send capability contract (validated; contentHash is a placeholder until compiled). */
export function messagingReplySendContract(): CapabilityContract {
  return CapabilityContract.parse({
    definitionId: 'def_cap_messaging_reply',
    kind: 'capability',
    version: '1.0.0',
    contentHash: `sha256:${'0'.repeat(64)}`,
    validatedAt: '2026-07-11T00:00:00.000Z',
    schemaRef: 'messaging-reply.capability/v1',
    name: 'messaging.reply.send',
    title: 'Send a reply message',
    description: 'Send a templated reply to a customer on their channel.',
    inputJsonSchema: {
      type: 'object',
      required: ['to'],
      properties: {
        to: {type: 'string'},
        template: {type: 'string'},
        body: {type: 'string'},
      },
    },
    outputJsonSchema: {
      type: 'object',
      required: ['providerMessageId', 'status'],
      properties: {
        providerMessageId: {type: 'string'},
        status: {type: 'string'},
      },
    },
    sideEffect: 'external',
    changedDomains: ['messaging', 'conversation'],
    idempotency: {
      required: true,
      keyFields: ['to', 'template'],
      ttlSeconds: 86400,
    },
    confirm: false,
    requiredScope: 'messaging.reply.send',
    providerMapping: {
      // Ranked failover (ADR-010): the real vendor is preferred; the internal message-log persists the
      // authoritative record and is the fallback when the vendor circuit is open or unconfigured. The
      // resolver skips a mapping entry with no registered adapter, so a deployment without vendor creds
      // simply lands on internal-message-log.
      providers: [
        {providerId: 'twilio-sms', priority: 200},
        {providerId: 'internal-message-log', priority: 100},
      ],
      eligibility: [],
      onNoProvider: 'fail',
    },
  });
}

export interface OutboundInput {
  to: string;
  template?: string;
  body?: string;
  conversationId?: string;
}

export interface MessageSendResult {
  providerMessageId: string;
  status: 'queued' | 'sent';
}

const shortHash = (s: string, n: number) =>
  createHash('sha256').update(s).digest('hex').slice(0, n);

/** Persists the outbound message to runtime.messages (the authoritative record); returns a receipt id. */
export class PersistingMessageProvider implements ProviderAdapter<
  OutboundInput,
  MessageSendResult
> {
  readonly providerId = 'internal-message-log';
  readonly capability = MESSAGING_REPLY_SEND;

  constructor(
    private readonly repo: DrizzleMessageRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async status(): Promise<ProviderStatus> {
    return {
      providerId: this.providerId,
      health: 'healthy',
      circuit: 'closed',
      lastCheckedAt: this.clock().toISOString() as IsoTimestamp,
    };
  }

  async execute(
    input: OutboundInput,
    ctx: ProviderExecutionContext,
  ): Promise<MessageSendResult> {
    const providerMessageId = `pm_${shortHash(ctx.idempotencyKey, 16)}`;
    await this.repo.appendOutbound(
      {
        messageId: `msg_${shortHash(ctx.idempotencyKey, 24)}`,
        conversationId:
          input.conversationId ?? `cnv_${shortHash(input.to, 16)}`,
        channel: 'sms',
        body: input.body ?? input.template,
        providerMessageId,
        status: 'queued',
        occurredAt: this.clock(),
      },
      {tenantId: ctx.tenantId as TenantId},
    );
    return {providerMessageId, status: 'queued'};
  }
}
