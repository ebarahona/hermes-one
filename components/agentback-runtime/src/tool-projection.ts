// CapabilityToolProjector (agentback/tool-projection.md) — the seam that makes a pinned
// CapabilityContract reachable as a real agentback @tool whose body resolves the ranked
// ProviderAdapter and calls it. Agent plane only.
//
// "One tool per pinned capability; body is generic. The projector does NOT author bespoke tool bodies
// for provider-neutral capabilities — the @tool method resolves the ranked provider adapter and calls
// it. Only a genuinely new provider-neutral capability ships code (ADR-013)." (tool-projection.md)
//
// The tool body returns the provider's UNWRAPPED output; the ToolResult envelope is synthesized
// upstream by PlatformToolExecutor from the contract metadata + dispatch hook (ADR-018). Wrapping it
// here would double-envelope.
//
// TWO LIBRARY/SPEC DELTAS (flagged, not improvised — see DEFERRED-AND-FLAGGED):
//  1. The spec's sequence calls `registerTool(name, opts)` on the agentback app. agentback 0.7.1 has
//     no such API: `@tool` is a plain legacy decorator that writes ToolMetadata into reflect-metadata
//     under 'mcp:tool', and `MCPServer.callTool` resolves by exact `===` on `meta.name`. The faithful
//     realization is to apply the shipped decorator programmatically and hand the resulting
//     ToolBinding to `callTool` via `CallToolOptions.binding`.
//  2. The spec projects the whole manifest once "at deployment activation". This worker is a
//     multi-tenant singleton, so an app-level registry keyed by tool NAME cannot hold two tenants'
//     different contracts for the same capability (the spec's own ToolProjectionReport.conflicts
//     anticipates the collision but not the multi-tenant case). We project PER TURN into bindings
//     that close over that turn's contracts + provider plane — no shared mutable registration, no
//     cross-tenant collision. `MCPServer.resolveMember` documents the unbound-ctor path this relies
//     on: "a discovered tool always has a tagged binding, so this is only reached for a class invoked
//     without one — instantiate with no DI". This is the spec's own "Lazy per-turn projection"
//     (Future Extensions), adopted early out of multi-tenant necessity.
import {tool} from '@agentback/mcp';
import type {ToolBinding} from '@agentback/mcp';
import type {
  CapabilityContract,
  CapabilityName,
  ChangedDomain,
  IdempotencySpec,
  ProviderAdapter,
  SideEffectClass,
  TenantId,
} from '@platform/contracts';
import {jsonSchemaToZod} from './json-schema-to-zod.js';

/** Resolves the ranked/eligible/healthy adapter for a capability (ProviderResolver.resolve). */
export type ProviderResolveFn = (
  capability: CapabilityName,
  mapping: CapabilityContract['providerMapping'],
  facts: Record<string, unknown>,
) => Promise<ProviderAdapter>;

/** Options the projector passes straight to agentback's `@tool(name, opts)`. */
export interface AgentbackToolOptions {
  input: unknown; // rebuilt FROM inputJsonSchema (ADR-020)
  output: unknown; // rebuilt FROM outputJsonSchema
  scope: string; // = CapabilityContract.requiredScope (ADR-019 visibility)
  confirm: boolean; // = CapabilityContract.confirm
  description: string;
  ui?: {title: string; description: string};
}

export interface ToolRegistration {
  capability: CapabilityName;
  bindingKey: string;
  confirm: boolean;
  autonomouslyProjectable: boolean;
}

export interface ToolProjectionReport {
  registered: ToolRegistration[];
  skipped: Array<{capability: CapabilityName; reason: string}>;
  conflicts: Array<{capability: CapabilityName; existingHash: string; incomingHash: string}>;
}

export interface CapabilityMetadata {
  capability: CapabilityName;
  sideEffect: SideEffectClass;
  changedDomains: ChangedDomain[];
  idempotency: IdempotencySpec;
  confirm: boolean;
}

/** Populated by the projector; read at dispatch for the ADR-018 envelope fields. */
export class CapabilityMetadataIndex {
  private readonly byName = new Map<string, CapabilityMetadata>();

  put(meta: CapabilityMetadata): void {
    this.byName.set(meta.capability, meta);
  }

  get(capability: CapabilityName): CapabilityMetadata | undefined {
    return this.byName.get(capability);
  }

  /** Every capability whose confirm === false — the autonomously-projectable subset. */
  autonomous(): CapabilityName[] {
    return [...this.byName.values()].filter(m => !m.confirm).map(m => m.capability);
  }
}

/** ADR-021: the platform drives single-step calls itself; agentback's autonomous loop is never used. */
export const autonomousProjectionEnabled = false as const;

/** Per-turn context the generic tool body needs to reach the provider plane. */
export interface ProjectionContext {
  tenantId: TenantId;
  /** Tenant-runtime facts the resolver evaluates provider eligibility against. */
  facts: Record<string, unknown>;
  /** Secrets resolved from the chosen provider's configKey — never logged, never in the contract. */
  providerConfig: Readonly<Record<string, string>>;
  /** Derived by the executor from the capability's IdempotencySpec; passed to the adapter. */
  idempotencyKeyFor: (capability: CapabilityName) => string;
}

const methodNameFor = (i: number) => `cap_${i}`;

export class CapabilityToolProjector {
  constructor(private readonly resolve: ProviderResolveFn) {}

  /**
   * Map one contract to its agentback `@tool` options (pure). `scope` is the contract's requiredScope
   * so `tools/list` visibility is correct; authorization ENFORCEMENT stays with agentback's voters —
   * the projector never re-implements it (tool-projection.md).
   */
  toToolOptions(contract: CapabilityContract): AgentbackToolOptions {
    return {
      input: jsonSchemaToZod(contract.inputJsonSchema),
      output: jsonSchemaToZod(contract.outputJsonSchema),
      scope: contract.requiredScope,
      confirm: contract.confirm,
      description: contract.description,
      ui: {title: contract.title, description: contract.description},
    };
  }

  /**
   * Project the pinned set into ToolBindings for ONE turn. Each body resolves the ranked provider and
   * returns its unwrapped output. A contract whose JSON Schema is outside the projector's allow-list
   * is SKIPPED (never silently degraded to a weaker validator) and reported.
   */
  project(
    contracts: readonly CapabilityContract[],
    ctx: ProjectionContext,
  ): {report: ToolProjectionReport; bindings: Map<string, ToolBinding>; metadata: CapabilityMetadataIndex} {
    const report: ToolProjectionReport = {registered: [], skipped: [], conflicts: []};
    const bindings = new Map<string, ToolBinding>();
    const metadata = new CapabilityMetadataIndex();

    // ONE class carries every projected tool as its own method. Generating a class per capability off
    // a shared base would inherit the base's tool metadata (MethodDecoratorFactory.allowInheritance
    // defaults true) and produce duplicate tool names.
    class ProjectedCapabilities {}
    Object.defineProperty(ProjectedCapabilities, 'name', {value: 'ProjectedCapabilities'});

    contracts.forEach((contract, i) => {
      const seen = bindings.get(contract.name);
      if (seen) {
        report.conflicts.push({
          capability: contract.name,
          existingHash: (seen.meta as {contentHash?: string}).contentHash ?? 'unknown',
          incomingHash: contract.contentHash ?? 'unknown',
        });
        return;
      }

      let opts: AgentbackToolOptions;
      try {
        opts = this.toToolOptions(contract);
      } catch (err) {
        report.skipped.push({capability: contract.name, reason: (err as Error).message});
        return;
      }

      const method = methodNameFor(i);
      const resolve = this.resolve;
      Object.defineProperty(ProjectedCapabilities.prototype, method, {
        value: async function (input: Record<string, unknown>): Promise<unknown> {
          // The generic body (tool-projection.md): resolve the ranked adapter, call it, return the
          // UNWRAPPED output. A NoProviderError propagates so the caller maps onNoProvider.
          const adapter = await resolve(contract.name, contract.providerMapping, ctx.facts);
          return adapter.execute(input, {
            tenantId: ctx.tenantId,
            capability: contract.name,
            idempotencyKey: ctx.idempotencyKeyFor(contract.name),
            config: ctx.providerConfig,
          });
        },
        writable: true,
        enumerable: false,
        configurable: true,
      });

      // Apply the SHIPPED decorator programmatically — it writes ToolMetadata under 'mcp:tool'. Zod
      // schemas survive the factory's deep-clone by identity (it bails on class instances).
      (tool as unknown as (name: string, o: Record<string, unknown>) => MethodDecorator)(contract.name, {
        input: opts.input,
        output: opts.output,
        description: opts.description,
        scope: opts.scope,
        confirm: opts.confirm,
      })(
        ProjectedCapabilities.prototype,
        method,
        Object.getOwnPropertyDescriptor(ProjectedCapabilities.prototype, method)!,
      );

      bindings.set(contract.name, {
        ctor: ProjectedCapabilities,
        meta: {name: contract.name, methodName: method, input: opts.input, output: opts.output, confirm: opts.confirm},
      } as unknown as ToolBinding);

      metadata.put({
        capability: contract.name,
        sideEffect: contract.sideEffect,
        changedDomains: contract.changedDomains,
        idempotency: contract.idempotency,
        confirm: contract.confirm,
      });

      report.registered.push({
        capability: contract.name,
        bindingKey: `platform.capability.tool.${contract.name}`,
        confirm: contract.confirm,
        autonomouslyProjectable: !contract.confirm,
      });
    });

    return {report, bindings, metadata};
  }
}
