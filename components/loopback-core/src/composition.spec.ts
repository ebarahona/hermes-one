// Component-boundary + plane-purity + app-boot tests. Deep resolution of datasource bindings (pool/redis construction) is covered by the
// live itests/e2es — here we assert the BINDING GRAPH: every key a component claims is bound after
// app.component(X), keys are plane-pure, and the pure services resolve.
import {describe, expect, it} from 'vitest';
import type {CapabilityContract} from '@platform/contracts';
import type {HermesConfig} from '@platform-internal/config';
import {
  CapabilityRegistryComponent,
  ObservabilityComponent,
  PersistenceComponent,
  PolicyRuntimeComponent,
  RuleRuntimeComponent,
  type IndexedCapabilityRegistry,
} from './index.js';
import {PlatformApplication} from './application.js';
import {PlatformBindings, PlatformExtensionPoints} from './bindings.js';
import type {PlatformComponentBoundary} from './boundary.js';
import {Binding, CoreTags} from '@loopback/core';
import type {ProviderAdapter, ProviderStatus} from '@platform/contracts';

const FAKE_CONFIG = {
  temporal: {address: 'x', namespace: 'default'},
  stores: {
    authoritative: {url: 'postgres://hermes:hermes@127.0.0.1:5433/hermes'},
    ephemeral: {url: 'redis://127.0.0.1:6380'},
    vector: {url: 'http://127.0.0.1:6333'},
  },
  llm: {baseUrl: 'http://127.0.0.1:8080/v1', model: 'm', apiKey: 'k'},
  outbox: {pollIntervalMs: 1000, maxAttempts: 10, channelPattern: 'events:{tenantId}:{aggregateType}', tenants: []},
} as unknown as HermesConfig;

const COMPONENTS = [
  ObservabilityComponent,
  PersistenceComponent,
  CapabilityRegistryComponent,
  RuleRuntimeComponent,
  PolicyRuntimeComponent,
];

function boot(): PlatformApplication {
  const app = new PlatformApplication();
  app.bind(PlatformBindings.CONFIG.key).to(FAKE_CONFIG);
  for (const c of COMPONENTS) app.component(c);
  return app;
}

describe('component boundary', () => {
  it('every key a component claims in bindsKeys is actually bound after registration', () => {
    const app = boot();
    for (const C of COMPONENTS) {
      const boundary = new C() as unknown as PlatformComponentBoundary;
      for (const key of boundary.bindsKeys) {
        expect(app.isBound(key), `${C.name} claims ${key} but it is not bound`).toBe(true);
      }
    }
  });

  it('components are plane-pure: edge components bind only platform.* keys, never platform.agent.*', () => {
    for (const C of COMPONENTS) {
      const boundary = new C() as unknown as PlatformComponentBoundary;
      expect(boundary.plane).toBe('edge');
      for (const key of boundary.bindsKeys) {
        expect(key).toMatch(/^platform\./);
        expect(key).not.toMatch(/^platform\.agent\./);
      }
    }
  });
});

describe('app boot (pure services resolve)', () => {
  it('resolves rule runtime, policy runtime, logger, meter, and the capability plane', async () => {
    const app = boot();
    expect(await app.get(PlatformBindings.RULE_RUNTIME)).toBeDefined();
    expect(await app.get(PlatformBindings.POLICY_RUNTIME)).toBeDefined();
    expect(await app.get(PlatformBindings.LOGGER)).toBeDefined();
    expect(await app.get(PlatformBindings.METER)).toBeDefined();
    expect(await app.get(PlatformBindings.CAPABILITY_REGISTRY)).toBeDefined();
  });

  it('discovers provider adapters contributed to the extension point (tagged bindings)', async () => {
    const app = boot();
    const fake: ProviderAdapter = {
      providerId: 'fake-provider',
      capability: 'messaging.reply.send' as ProviderAdapter['capability'],
      status: async () =>
        ({providerId: 'fake-provider', health: 'healthy', circuit: 'closed', lastCheckedAt: new Date().toISOString()}) as ProviderStatus,
      execute: async () => ({}),
    };
    app.add(
      Binding.bind('platform.providers.fake')
        .to(fake)
        .tag({[CoreTags.EXTENSION_FOR]: PlatformExtensionPoints.PROVIDER_ADAPTERS}),
    );
    const registry = await app.get(PlatformBindings.PROVIDER_REGISTRY);
    expect(registry.get(fake.capability, 'fake-provider')).toBe(fake);
  });

  it('the invoker resolves over the registry lookup (sync latest-by-name index)', async () => {
    const app = boot();
    const registry = (await app.get(PlatformBindings.CAPABILITY_REGISTRY)) as IndexedCapabilityRegistry;
    const contract = {
      definitionId: 'def_test_slot_read',
      kind: 'capability',
      version: '1.0.0',
      contentHash: `sha256:${'a'.repeat(64)}`,
      validatedAt: '2026-07-14T00:00:00.000Z',
      schemaRef: 'appointment-slot-read.capability/v1',
      name: 'appointment.slot.read',
      title: 'Read slots',
      description: 'x',
      inputJsonSchema: {type: 'object'},
      outputJsonSchema: {type: 'object'},
      sideEffect: 'read',
      changedDomains: ['none'],
      idempotency: {required: false, keyFields: [], ttlSeconds: 86400},
      confirm: false,
      requiredScope: 'appointment.slot.read',
      providerMapping: {providers: [{providerId: 'internal', priority: 100}], eligibility: [], onNoProvider: 'fail'},
    } as unknown as CapabilityContract;
    await registry.register(contract);
    expect(registry.lookup(contract.name)).toMatchObject({name: 'appointment.slot.read'});
    expect(await app.get(PlatformBindings.CAPABILITY_INVOKER)).toBeDefined();
  });
});
