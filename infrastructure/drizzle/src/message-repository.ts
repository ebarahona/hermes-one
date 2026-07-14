// Tenant-scoped writer for runtime.messages (RLS 'strict'). The outbound side of the messaging
// capability persists here — idempotently (ON CONFLICT(message_id) DO NOTHING), so a replayed send
// collapses to one row. All access goes through withTenant → set_config('app.tenant_id').
import type {TenantScope} from '@platform/contracts';
import {TenantAwareRepository} from './tenant-aware.repository.js';
import {messages} from './schema/runtime.schema.js';

type MessageStatus =
  | 'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'undelivered';
type Channel = 'sms' | 'whatsapp' | 'webchat' | 'email' | 'voice' | 'api';

export interface OutboundMessageRow {
  messageId: string;
  conversationId: string;
  turnId?: string;
  channel: Channel;
  senderPrincipalId?: string;
  body?: string;
  providerMessageId?: string;
  status: MessageStatus;
  occurredAt: Date;
}

export interface InboundMessageRow {
  messageId: string;
  conversationId: string;
  channel: Channel;
  senderPrincipalId?: string;
  body?: string;
  providerMessageId: string;
  status: MessageStatus;
  occurredAt: Date;
}

export class DrizzleMessageRepository extends TenantAwareRepository {
  /** Persist an inbound message for a tenant. Idempotent — a replayed provider webhook collapses. */
  async appendInbound(msg: InboundMessageRow, scope: TenantScope): Promise<void> {
    await this.withTenant(scope, async tx => {
      await tx
        .insert(messages)
        .values({
          messageId: msg.messageId,
          tenantId: scope.tenantId,
          conversationId: msg.conversationId,
          direction: 'inbound',
          channel: msg.channel,
          senderPrincipalId: msg.senderPrincipalId,
          body: msg.body,
          providerMessageId: msg.providerMessageId,
          status: msg.status,
          occurredAt: msg.occurredAt,
        })
        .onConflictDoNothing();
    });
  }

  /** Persist an outbound message for a tenant. Idempotent on message_id. */
  async appendOutbound(msg: OutboundMessageRow, scope: TenantScope): Promise<void> {
    await this.withTenant(scope, async tx => {
      await tx
        .insert(messages)
        .values({
          messageId: msg.messageId,
          tenantId: scope.tenantId,
          conversationId: msg.conversationId,
          turnId: msg.turnId,
          direction: 'outbound',
          channel: msg.channel,
          senderPrincipalId: msg.senderPrincipalId,
          body: msg.body,
          providerMessageId: msg.providerMessageId,
          status: msg.status,
          occurredAt: msg.occurredAt,
        })
        .onConflictDoNothing({target: messages.messageId});
    });
  }
}
