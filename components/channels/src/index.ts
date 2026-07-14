// @platform-internal/channels — component (edge plane).
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
export {
  VendorSmsProvider,
  TWILIO_SMS_PROVIDER_ID,
  type CircuitConfig,
} from './vendor-sms-provider.js';
export {
  StaticProviderCredentialStore,
  MissingCredentialsError,
  type ProviderCredentialStore,
} from './credential-store.js';

export const descriptor = {
  name: '@platform-internal/channels',
  role: 'component',
  plane: 'edge',
  published: false,
  sourceDocs: ['12-provider-adapters/120', 'contracts/provider-contracts'],
  governedBy: ['ADR-010', 'ADR-018'],
} as const;
