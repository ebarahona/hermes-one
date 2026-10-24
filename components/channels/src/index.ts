// @hermes-one/channels — component (edge plane).
// Channel/provider adapters for customer messaging. The messaging.reply.send provider persists the
// outbound message to runtime.messages (the real side effect behind the capability plane).

export {
  messagingReplySendContract,
  PersistingMessageProvider,
  MESSAGING_REPLY_SEND,
  type OutboundInput,
  type MessageSendResult,
} from './messaging.js';
export {
  SmsChannelTransport,
  smsSignedMaterial,
  type SmsTransportConfig,
  type TenantByNumber,
  type FetchLike,
} from './sms-transport.js';
export {ChannelComponent} from './channel.component.js';
export {
  VendorSmsProvider,
  TWILIO_SMS_PROVIDER_ID,
  type CircuitConfig,
} from './vendor-sms-provider.js';

export const descriptor = {
  name: '@hermes-one/channels',
  role: 'component',
  plane: 'edge',
  published: false,
  governedBy: ['ADR-010', 'ADR-018'],
} as const;
