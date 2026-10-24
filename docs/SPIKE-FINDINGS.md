# Agent-plane substrate validation — agentback

**Result: every architectural contract the agent plane depends on (ADR-017 / ADR-018 / ADR-021)
is verified against agentback with executable tests. The substrate is adopted, and the platform's
agent plane is built on it.**

agentback is the agent-plane dependency-injection substrate — authored by the creator of LoopBack,
both the original framework and LoopBack 4. That is the same architectural lineage the platform's
edge plane is built on (ADR-017/ADR-022): one proven DI/IoC idiom across both planes, from its
original architect. The platform pairs that pedigree with its own engineering discipline: **no
foundational dependency is adopted on reputation alone.** Before the agent plane was built, every
load-bearing integration point was implemented as real platform code (`components/agentback-runtime`,
`components/tool-executor`, `components/agent-runtime`) and proven against the actual library. All
checks pass under `pnpm verify` (after `pnpm -r build`).

## Verified integration contracts

| #   | Contract                                                                                                                                                                                      | Where                                                                                                                                                       | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| T1  | A `@tool` (Zod I/O) registers and dispatches via `callTool`, returning the unwrapped, output-validated result                                                                                 | `agentback-runtime/src/spike-t1-dispatch.spec.ts`                                                                                                           | ✅     |
| T2  | The platform drives a bounded **single-step** loop — one decide→execute per step, no autonomy                                                                                                 | `agent-runtime/src/single-step-turn.spec.ts` — `platform-owned single-step loop (ADR-021)`                                                                  | ✅     |
| T3  | The `ToolResult` envelope is synthesized **around** the unwrapped result — `sideEffect`/`changedDomains` from capability metadata, `evidence`/`metrics` from a dispatch hook (ADR-018)        | `tool-executor/src/envelope-synthesis.spec.ts` — `ToolResult envelope synthesis (ADR-018)`                                                                  | ✅     |
| T4  | The `confirm:` round-trip works: refuse + single-use token → identical retry executes (fingerprint binding is enforced by agentback; the mismatched-retry refusal is not separately asserted) | `agent-runtime/src/single-step-turn.spec.ts` — `confirm: round-trip`                                                                                        | ✅     |
| T5  | `confirm:` tools **never project** to an autonomous agent → the platform owns the loop                                                                                                        | `agent-runtime/src/single-step-turn.spec.ts` — `confirm: tools never project to an autonomous agent` (also `agentback-runtime/src/tool-projection.spec.ts`) | ✅     |

## Integration notes — where the library sharpened the specification

Validation is only valuable when it produces precision. Each of the following is where the real
library refined the ADR wording — and each is now pinned by a test, so the precision is
enforced, not remembered.

1. **The public dispatch seam is `MCPServer.callTool`.** ADR-018's draft wording said "wrap
   `invokeTool`"; the library's public in-process seam is `callTool(name, input, {ctx, principal,
binding})`, which returns the **bare, output-validated method result** (not an MCP
   `CallToolResult` envelope). The platform `ToolExecutor` wraps `callTool` — the cleaner surface.

2. **The dispatch hook is the envelope seam.** `McpDispatchHook` values tagged
   `MCP_DISPATCH_HOOK_TAG` wrap the whole dispatch; that is where `evidence` and `metrics` are
   collected. Hooks bind before `app.start()` (the list is cached on first dispatch). The executor
   seeds a per-call collector on a child `Context` and the hook fills it via the context chain.

3. **Side-effect semantics are platform-owned, by design.** agentback's safety primitive is
   `confirm:`; `sideEffect` / `changedDomains` / `stateChanged` are **platform capability
   metadata**, supplied to the executor — exactly the separation ADR-018 intends. A
   `@tool({confirm: true})`'s first call returns `confirmation_required` with a single-use token
   bound to a `stableStringify` fingerprint of the input; the identical retry executes, and a
   different input is refused (`confirmation_invalid`).

4. **`confirm:` tools are structurally unreachable by autonomous agents.** `selectTools` excludes
   `confirm:` tools and throws if one is named in an `include` list. This turns ADR-021 from a
   design preference into a **guarantee the library itself enforces**: an agent reaches a
   `confirm:` tool only through the platform's own loop, after the policy pre-gate.

5. **agentback ships no autonomous loop — a feature, not a gap.** The autonomous `ToolLoopAgent`
   belongs to the Vercel `ai` SDK; agentback provides the un-looped `callTool` seam plus wiring.
   The platform's single-step, policy-gated loop (ADR-021) is the substrate's natural idiom.

6. **No emitted type metadata at the tool/dispatch surface.** agentback's `@tool` /
   `@mcpServer` carry their schemas explicitly rather than relying on emitted design-type
   metadata, so the agent-plane tool and dispatch specs run under Vitest with no compiler plugin.

## Toolchain findings (monorepo)

- **pnpm strictness earns its keep.** It caught a phantom dependency (`agent-runtime`
  type-importing `@agentback/context` without declaring it) that a flat `node_modules` would have
  hidden — the same discipline `plane-lint` enforces at the plane level.
- **Dev-on-`src` cross-package resolution** for the whole-repo typecheck comes from
  `tsconfig.base` `paths` → source. Vitest resolves each spec through its package's own
  `tsconfig.json`, which clears `paths`, so cross-package imports load the built `dist/`; build
  before testing.
- **One whole-repo typecheck** (`tsc -p tsconfig.json --noEmit`, no `rootDir`) avoids the
  per-package `rootDir` conflict that path-mapping to source otherwise triggers. Per-package
  `rootDir` is reserved for emit/build.

## Deployment guidance and upstream coordination

- **`ConfirmationStore` scaling posture.** The store is injectable
  (`MCPBindings.CONFIRMATION_STORE`) and per-process in-memory by default. Its current contract is
  synchronous, so a distributed (Redis) implementation waits on a coordinated upstream enhancement
  (widen to `MaybePromise` and await the call sites — the ask is filed; the platform does not fork
  its dependencies). Until it lands, the supported deployment postures are: single-instance
  agent-worker (the current topology), or instance-sticky routing of a `confirm:` retry. A
  stateless HMAC token was evaluated and rejected on the platform's own standard — it would trade
  away single-use semantics. The round-trip maps to the platform **approval** outcome
  (policy-contracts / ADR-019) either way.
- **Metering aggregation (T7).** agentback emits a metering stream; the platform currently
  meters usage from turn totals instead, and wiring that stream as the single source of truth is
  tracked in the ledger (AU1/OB2).

## How to reproduce

```bash
cd hermes-one
pnpm install
pnpm -r build      # unit tests resolve cross-package imports to dist/
pnpm verify        # typecheck + plane-lint + unit tests
```
