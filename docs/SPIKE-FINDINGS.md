# Agent-plane library validation: agentback

**Result: every architectural contract the agent plane depends on (ADR-017 / ADR-018 / ADR-021)
is verified against agentback with executable tests. The library is adopted, and the platform's
agent plane is built on it.**

agentback is the dependency-injection library the agent plane runs on. It's written by the creator
of LoopBack (both the original framework and LoopBack 4), which is the same lineage the edge plane
is built on (ADR-017/ADR-022). So both planes use one proven DI/IoC idiom from the same original
architect. Reputation alone wasn't enough to adopt it, though. Before the agent plane was built,
every load-bearing integration point was written as real platform code
(`components/agentback-runtime`, `components/tool-executor`, `components/agent-runtime`) and tested
against the actual library. All checks pass under `pnpm verify` (after `pnpm -r build`).

## Verified integration contracts

| #   | Contract                                                                                                                                                                                      | Where                                                                                                                                                      | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| T1  | A `@tool` (Zod I/O) registers and dispatches via `callTool`, returning the unwrapped, output-validated result                                                                                 | `agentback-runtime/src/spike-t1-dispatch.spec.ts`                                                                                                          | ✅     |
| T2  | The platform drives a bounded **single-step** loop: one decide→execute per step, no autonomy                                                                                                  | `agent-runtime/src/single-step-turn.spec.ts`, `platform-owned single-step loop (ADR-021)`                                                                  | ✅     |
| T3  | The `ToolResult` envelope is built **around** the unwrapped result: `sideEffect`/`changedDomains` from capability metadata, `evidence`/`metrics` from a dispatch hook (ADR-018)               | `tool-executor/src/envelope-synthesis.spec.ts`, `ToolResult envelope synthesis (ADR-018)`                                                                  | ✅     |
| T4  | The `confirm:` round-trip works: refuse + single-use token → identical retry executes (fingerprint binding is enforced by agentback; the mismatched-retry refusal is not separately asserted) | `agent-runtime/src/single-step-turn.spec.ts`, `confirm: round-trip`                                                                                        | ✅     |
| T5  | `confirm:` tools **never project** to an autonomous agent → the platform owns the loop                                                                                                        | `agent-runtime/src/single-step-turn.spec.ts`, `confirm: tools never project to an autonomous agent` (also `agentback-runtime/src/tool-projection.spec.ts`) | ✅     |

## Integration notes: where the library sharpened the spec

Each item below is a place where the real library made the ADR wording more precise. Each one is
now pinned by a test, so it's enforced instead of just remembered.

1. **The public dispatch seam is `MCPServer.callTool`.** ADR-018's draft wording said "wrap
   `invokeTool`". The library's public in-process seam is `callTool(name, input, {ctx, principal,
binding})`. It returns the **bare, output-validated method result** instead of an MCP
   `CallToolResult` envelope. The platform `ToolExecutor` wraps `callTool`, which is the cleaner
   surface.

2. **The dispatch hook is the envelope seam.** `McpDispatchHook` values tagged
   `MCP_DISPATCH_HOOK_TAG` wrap the whole dispatch, and that's where `evidence` and `metrics` are
   collected. Hooks bind before `app.start()` (the list is cached on first dispatch). The executor
   seeds a per-call collector on a child `Context`, and the hook fills it through the context
   chain.

3. **Side-effect semantics belong to the platform, by design.** agentback's safety primitive is
   `confirm:`. `sideEffect` / `changedDomains` / `stateChanged` are **platform capability
   metadata** passed to the executor, which is exactly the separation ADR-018 intends. The first
   call to a `@tool({confirm: true})` returns `confirmation_required` with a single-use token bound
   to a `stableStringify` fingerprint of the input. The identical retry executes, and a different
   input is refused (`confirmation_invalid`).

4. **Autonomous agents can't reach `confirm:` tools at all.** `selectTools` excludes `confirm:`
   tools and throws if one is named in an `include` list. That makes ADR-021 a **guarantee the
   library enforces** instead of a design preference. An agent reaches a `confirm:` tool only
   through the platform's own loop, after the policy pre-gate.

5. **agentback ships no autonomous loop, and that's intended.** The autonomous `ToolLoopAgent`
   belongs to the Vercel `ai` SDK. agentback provides the un-looped `callTool` seam plus wiring.
   The platform's single-step, policy-gated loop (ADR-021) is the natural way to use the library.

6. **No emitted type metadata at the tool/dispatch surface.** agentback's `@tool` /
   `@mcpServer` carry their schemas explicitly instead of relying on emitted design-type
   metadata. So the agent-plane tool and dispatch specs run under Vitest with no compiler plugin.

## Toolchain findings (monorepo)

- **pnpm strictness pays off.** It caught a phantom dependency (`agent-runtime` type-importing
  `@agentback/context` without declaring it) that a flat `node_modules` would have hidden. It's the
  same discipline `plane-lint` enforces at the plane level.
- **Dev-on-`src` cross-package resolution** for the whole-repo typecheck comes from
  `tsconfig.base` `paths` → source. Vitest resolves each spec through its package's own
  `tsconfig.json`, which clears `paths`, so cross-package imports load the built `dist/`. Build
  before testing.
- **One whole-repo typecheck** (`tsc -p tsconfig.json --noEmit`, no `rootDir`) avoids the
  per-package `rootDir` conflict that path-mapping to source otherwise triggers. Per-package
  `rootDir` is kept for emit/build.

## Deployment guidance and upstream coordination

- **`ConfirmationStore` scaling.** The store is injectable (`MCPBindings.CONFIRMATION_STORE`) and
  per-process in-memory by default. Its current contract is synchronous, so a distributed (Redis)
  implementation waits on an upstream change: widen it to `MaybePromise` and await the call sites.
  That request is filed, and the platform doesn't fork its dependencies. Until it lands, there are
  two supported deployment setups: a single-instance agent-worker (the current topology), or
  instance-sticky routing of a `confirm:` retry. A stateless HMAC token was evaluated and rejected
  because it would give up single-use semantics. Either way, the round-trip maps to the platform
  **approval** outcome (policy-contracts / ADR-019).
- **Metering aggregation (T7).** agentback emits a metering stream. The platform currently meters
  usage from turn totals instead. Wiring that stream in as the single source of truth is tracked in
  the ledger (AU1/OB2).

## How to reproduce

```bash
cd hermes-one
pnpm install
pnpm -r build      # unit tests resolve cross-package imports to dist/
pnpm verify        # typecheck + plane-lint + unit tests
```
