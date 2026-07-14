// Holds the concrete ProviderAdapters (vendor realizations of a capability), keyed by
// (capability, providerId). The composition root registers the adapters it wires; the resolver
// looks them up by the ProviderRef the ProviderMapping ranks.
import type {CapabilityName, ProviderAdapter} from '@platform/contracts';

const key = (capability: string, providerId: string) => `${capability}::${providerId}`;

export class ProviderRegistry {
  private readonly byKey = new Map<string, ProviderAdapter>();

  constructor(adapters: ProviderAdapter[] = []) {
    for (const a of adapters) this.register(a);
  }

  register(adapter: ProviderAdapter): void {
    this.byKey.set(key(adapter.capability, adapter.providerId), adapter);
  }

  get(capability: CapabilityName, providerId: string): ProviderAdapter | undefined {
    return this.byKey.get(key(capability, providerId));
  }
}
