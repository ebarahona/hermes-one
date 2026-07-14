// Ranked provider resolution (ADR-010). Given a capability's ProviderMapping and the tenant-runtime
// facts, pick the highest-priority provider that is (a) request-eligible, (b) registered, (c) healthy.
// Priority encodes tenant-override > vertical-default > platform-default (higher wins); ties break
// deterministically by providerId. Eligibility is a shared expression over facts (feature flags,
// residency, consent). When nothing resolves, the caller decides fail-vs-handoff from onNoProvider.
import {
  builtinRegistry,
  evaluatePredicate,
  type OperatorRegistry,
} from '@platform/expression-core';
import type {
  CapabilityName,
  ProviderAdapter,
  ProviderMapping,
} from '@platform/contracts';
import type {ProviderRegistry} from './provider-registry.js';

/** Raised when no provider can serve a request. `onNoProvider` tells the caller to fail or hand off. */
export class NoProviderError extends Error {
  constructor(
    readonly capability: CapabilityName,
    readonly onNoProvider: 'fail' | 'handoff',
    readonly reasons: readonly string[],
  ) {
    super(
      `no provider available for ${capability}: ${reasons.join('; ') || 'all providers unhealthy'}`,
    );
    this.name = 'NoProviderError';
  }
}

export class ProviderResolver {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly operators: OperatorRegistry = builtinRegistry(),
  ) {}

  async resolve(
    capability: CapabilityName,
    mapping: ProviderMapping,
    facts: Record<string, unknown>,
  ): Promise<ProviderAdapter> {
    // 1. Request-level eligibility: every rule must hold, else the capability is ineligible here.
    const failed = mapping.eligibility.filter(
      rule => !evaluatePredicate(rule.when, {facts, parameters: {}, registry: this.operators}),
    );
    if (failed.length > 0) {
      throw new NoProviderError(capability, mapping.onNoProvider, failed.map(r => r.reason));
    }

    // 2. Rank by priority (desc), tie-broken deterministically by providerId (asc).
    const ranked = [...mapping.providers].sort(
      (a, b) => b.priority - a.priority || a.providerId.localeCompare(b.providerId),
    );

    // 3. First registered + healthy provider wins.
    for (const ref of ranked) {
      const adapter = this.providers.get(capability, ref.providerId);
      if (!adapter) continue;
      const status = await adapter.status();
      if (status.health !== 'unavailable' && status.circuit !== 'open') return adapter;
    }

    throw new NoProviderError(capability, mapping.onNoProvider, [
      'no registered provider is healthy',
    ]);
  }
}
