// CapabilityRegistryComponent (edge): binds the capability plane — registry, provider registry,
// resolver, invoker. Consumes the `providerAdapters` extension
// point: provider adapters are contributed by other components / the composition root as bindings
// tagged `{extensionFor: 'platform.extensions.providerAdapters'}` (the real LB4 extension-point
// idiom) and discovered here at first resolution — no name→provider Map, no hardcoded list.
import {Binding, CoreTags, type Component} from '@loopback/core';
import {BindingScope} from '@loopback/context';
import type {CapabilityContract, CapabilityName, ProviderAdapter, ProviderMapping} from '@platform/contracts';
import {
  CapabilityInvoker,
  InMemoryCapabilityRegistry,
  ProviderRegistry,
  ProviderResolver,
} from '@platform/capability-contract';
import {PlatformBindings, PlatformExtensionPoints} from '../bindings.js';
import type {PlatformComponentBoundary} from '../boundary.js';

/**
 * The registry plus a latest-by-name index backing the invoker's SYNC `CapabilityLookup`
 * (JIT convenience — replaces the ad-hoc Map the worker composition kept; the canonical async
 * `get(name, version)` port is untouched).
 */
export class IndexedCapabilityRegistry extends InMemoryCapabilityRegistry {
  private readonly latestByName = new Map<string, CapabilityContract>();

  override async register(cap: CapabilityContract): Promise<void> {
    await super.register(cap);
    this.latestByName.set(cap.name, cap);
  }

  lookup = (name: CapabilityName): CapabilityContract | undefined => this.latestByName.get(name);
}

export class CapabilityRegistryComponent implements Component, PlatformComponentBoundary {
  readonly plane = 'edge' as const;
  readonly bindsKeys = [
    PlatformBindings.CAPABILITY_REGISTRY.key,
    PlatformBindings.CAPABILITY_RESOLVER.key,
    PlatformBindings.PROVIDER_REGISTRY.key,
    PlatformBindings.CAPABILITY_INVOKER.key,
  ];
  readonly implementsExtensionPoints: readonly string[] = [];
  readonly consumesExtensionPoints = [PlatformExtensionPoints.PROVIDER_ADAPTERS];
  readonly contributesTags: readonly string[] = [];

  bindings: Binding[] = [
    Binding.bind(PlatformBindings.CAPABILITY_REGISTRY.key)
      .toDynamicValue(() => new IndexedCapabilityRegistry())
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.PROVIDER_REGISTRY.key)
      .toDynamicValue(({context}) => {
        // Discover every provider adapter contributed to the extension point (tagged bindings).
        const adapters = context
          .findByTag<ProviderAdapter>({[CoreTags.EXTENSION_FOR]: PlatformExtensionPoints.PROVIDER_ADAPTERS})
          .map(b => context.getSync<ProviderAdapter>(b.key));
        return new ProviderRegistry(adapters);
      })
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.CAPABILITY_RESOLVER.key)
      .toDynamicValue(({context}) => new ProviderResolver(context.getSync(PlatformBindings.PROVIDER_REGISTRY)))
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.CAPABILITY_INVOKER.key)
      .toDynamicValue(({context}) => {
        const registry = context.getSync(PlatformBindings.CAPABILITY_REGISTRY) as IndexedCapabilityRegistry;
        // Tenant provider-mapping overrides (CT3): consulted at INVOCATION time, before ranking —
        // absence of a row (or of the repository binding itself) means the contract default.
        const overrides = context.isBound(PlatformBindings.PROVIDER_MAPPING_REPOSITORY.key)
          ? (context.getSync(PlatformBindings.PROVIDER_MAPPING_REPOSITORY) as {
              find(t: unknown, n: unknown): Promise<(ProviderMapping & {updatedAt: string; updatedBy: string}) | null>;
            })
          : undefined;
        return new CapabilityInvoker(
          registry.lookup,
          context.getSync(PlatformBindings.CAPABILITY_RESOLVER),
          overrides
            ? async (tenantId, capability) => {
                const o = await overrides.find(tenantId, capability);
                return o ? {providers: o.providers, eligibility: o.eligibility, onNoProvider: o.onNoProvider} : null;
              }
            : undefined,
        );
      })
      .inScope(BindingScope.SINGLETON),
  ];
}
