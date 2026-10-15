// ChannelComponent (edge) — the channel plane's contribution to the
// capability extension point. Contributes the provider adapters as `extensionFor`-tagged bindings the
// CapabilityRegistryComponent discovers (LB4 extension-point idiom — no hardcoded provider lists in
// composition roots): the persist-only internal message-log provider always; the real SMS vendor only
// when configured (the contract's providerMapping ranks twilio-sms > internal-message-log and the
// resolver fails over when the vendor circuit is open).
//
// The full ChannelComponent (transport lifecycle, per-channel components as MVP expands — L1/L7)
// grows here; this slice owns exactly what the roots used to wire inline.
import {Binding, CoreTags, type Component} from '@loopback/core';
import {BindingScope, inject} from '@loopback/context';
import {
  PlatformBindings,
  PlatformExtensionPoints,
  type PlatformComponentBoundary,
} from '@platform-internal/loopback-core';
import type {HermesConfig} from '@platform-internal/config';
import {PersistingMessageProvider} from './messaging.js';
import {SmsChannelTransport} from './sms-transport.js';
import {StaticProviderCredentialStore} from '@platform-internal/secrets';
import {
  VendorSmsProvider,
  TWILIO_SMS_PROVIDER_ID,
} from './vendor-sms-provider.js';

export class ChannelComponent implements Component, PlatformComponentBoundary {
  readonly plane = 'edge' as const;
  readonly bindsKeys: readonly string[] = []; // contributes extensions, owns no platform.* key
  readonly implementsExtensionPoints = [
    PlatformExtensionPoints.PROVIDER_ADAPTERS,
  ];
  readonly consumesExtensionPoints: readonly string[] = [];
  readonly contributesTags = [PlatformExtensionPoints.PROVIDER_ADAPTERS];

  bindings: Binding[];

  constructor(@inject(PlatformBindings.CONFIG) cfg: HermesConfig) {
    this.bindings = [
      Binding.bind('platform.providers.internal-message-log')
        .toDynamicValue(
          ({context}) =>
            new PersistingMessageProvider(
              context.getSync(PlatformBindings.MESSAGE_REPOSITORY),
            ),
        )
        .inScope(BindingScope.SINGLETON)
        .tag({
          [CoreTags.EXTENSION_FOR]: PlatformExtensionPoints.PROVIDER_ADAPTERS,
        }),
    ];
    if (cfg.sms) {
      const sms = cfg.sms;
      this.bindings.push(
        Binding.bind('platform.providers.twilio-sms')
          .toDynamicValue(({context}) => {
            // Outbound-only transport instance; deliver() reads creds from ctx.config.
            const transport = new SmsChannelTransport({
              signingSecret: 'unused-outbound',
              signatureHeader: 'x-signature',
              tenantByNumber: () => null,
              vendorBaseUrl: sms.baseUrl,
              timeoutMs: sms.timeoutMs,
            });
            const creds = new StaticProviderCredentialStore({
              [TWILIO_SMS_PROVIDER_ID]: {
                accountSid: sms.accountSid,
                authToken: sms.authToken,
                from: sms.from,
              },
            });
            return new VendorSmsProvider(
              transport,
              context.getSync(PlatformBindings.MESSAGE_REPOSITORY),
              creds,
            );
          })
          .inScope(BindingScope.SINGLETON)
          .tag({
            [CoreTags.EXTENSION_FOR]: PlatformExtensionPoints.PROVIDER_ADAPTERS,
          }),
      );
    }
  }
}
