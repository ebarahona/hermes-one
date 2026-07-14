# AgentBack de-risking spike — findings

**Verdict: ADR-017 / ADR-018 / ADR-021 hold against the real agentback `0.7.1`
substrate. Green light to build the agent plane on it.**

The agent plane bets everything on agentback, which is **pre-1.0 ("API still
settling")**. Before building on it, this spike validated the four load-bearing
integration points as real platform code (`components/agentback-runtime`,
`components/tool-executor`, `components/agent-runtime`), tested against the actual
library. All checks pass under `pnpm verify` (16 tests).

## What was validated

| #   | Claim                                                                                                                                                                                  | Where                                             | Status |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------ |
| T1  | A `@tool` (Zod I/O) registers and dispatches via `callTool`, returning the unwrapped, output-validated result                                                                          | `agentback-runtime/src/spike-t1-dispatch.spec.ts` | ✅     |
| T2  | The platform drives a bounded **single-step** loop — one decide→execute per step, no autonomy                                                                                          | `agent-runtime/src/spike-confirm-loop.spec.ts`    | ✅     |
| T3  | The `ToolResult` envelope is synthesized **around** the unwrapped result — `sideEffect`/`changedDomains` from capability metadata, `evidence`/`metrics` from a dispatch hook (ADR-018) | `tool-executor/src/spike-t3-envelope.spec.ts`     | ✅     |
| T4  | The `confirm:` round-trip works: refuse + single-use token → identical retry executes; fingerprint-bound                                                                               | `agent-runtime/src/spike-confirm-loop.spec.ts`    | ✅     |
| T5  | `confirm:` tools **never project** to an autonomous agent → the platform must own the loop                                                                                             | `agent-runtime/src/spike-confirm-loop.spec.ts`    | ✅     |

## Reality-vs-assumption deltas (the useful part)

These are where the real library differs from, or sharpens, the ADR/spec wording.
Each is now pinned by a test.

1. **`invokeTool` is `private` — wrap the public `MCPServer.callTool` instead.**
   ADR-018 says "wrap agentback `invokeTool`"; in `0.7.1` `invokeTool` is a
   private method. The public in-process seam is `callTool(name, input, {ctx,
principal, binding})`, which returns the **bare, output-validated method
   result** (not an MCP `CallToolResult` envelope). The `ToolExecutor` wraps
   `callTool`. _(Recommend the ADR text be updated: "wrap `callTool`".)_

2. **The dispatch hook is the envelope seam.** `McpDispatchHook` values tagged
   `MCP_DISPATCH_HOOK_TAG` wrap the whole dispatch; that is where `evidence` and
   `metrics` are collected. **Hooks must be bound before `app.start()`** (the list
   is cached on first dispatch). The executor seeds a per-call collector on a child
   `Context` and the hook fills it via the context chain.

3. **`confirm:` is agentback's only side-effect primitive; there is no
   `sideEffect` field on `@tool`.** So `sideEffect` / `changedDomains` /
   `stateChanged` are **platform capability metadata**, supplied to the executor —
   exactly as ADR-018 intends. A `@tool({confirm: true})`'s first call throws
   `code: 'confirmation_required'` with a `confirmationToken`; the identical retry
   carrying the token in the input executes. The token is bound to a
   `stableStringify` fingerprint of the input, so it can't be replayed against
   different arguments (`confirmation_invalid`).

4. **`confirm:` tools never project to an autonomous agent.** `selectTools`
   (and therefore `toHostTools`) **excludes** `confirm:` tools and **throws** if one
   is named in an `include` list. An AI-SDK agent literally cannot call them. This
   turns ADR-021 from a preference into a requirement: the platform **must** own the
   loop and dispatch `confirm:` tools itself, post-approval-gate.

5. **agentback ships no autonomous loop.** `ToolLoopAgent` lives in the Vercel
   `ai` SDK, not agentback. agentback provides `callTool` (the un-looped seam) plus
   optional wiring. Single-step, platform-owned is the only faithful option — again
   confirming ADR-021.

6. **Decorator metadata is not required at the tool/dispatch surface.**
   agentback's `@tool` / `@mcpServer` carry their schemas explicitly, so tests run
   under **Vitest-on-`src`** with no build, no swc plugin, and no `reflect-metadata`
   — matching the agentback consumer demo. This is what makes the dev-on-src loop
   viable.

## Toolchain findings (monorepo)

- **pnpm strictness earns its keep.** It caught a phantom dependency
  (`agent-runtime` type-importing `@agentback/context` without declaring it) that a
  flat `node_modules` would have hidden — the same discipline `plane-lint` enforces
  at the plane level.
- **Dev-on-`src` cross-package resolution** works via one source of truth:
  `tsconfig.base` `paths` → source, consumed by `tsc` and by Vitest's native
  `resolve.tsconfigPaths`. No build step in the dev loop.
- **One whole-repo typecheck** (`tsc -p tsconfig.json --noEmit`, no `rootDir`)
  avoids the per-package `rootDir` conflict that path-mapping to source otherwise
  triggers. Per-package `rootDir` is reserved for emit/build.

## Residual / deferred

- **`ConfirmationStore` is per-process in-memory by default — and a shared (Redis) store is
  IMPOSSIBLE against `0.7.1`'s contract (AUTH-4 investigation, 2026-07-14).** The seam IS injectable
  (`MCPBindings.CONFIRMATION_STORE`, resolved by `MCPServer.confirmationStore()`), but the interface
  is **synchronous** (`issue(scope, fingerprint, ttlMs?): string`, `verify(token, scope, fingerprint):
  boolean` — `@agentback/common` `utils/safety.d.ts`) and the server consumes it unawaited:
  `if (!store.verify(token, scope, fingerprint))` (`mcp.server.js:311`). A Promise-returning
  implementation is ALWAYS truthy there → the invalid-token branch never fires → **fail-open** —
  a distributed shim is actively dangerous, not merely awkward. **Upstream ask (flagged, do not
  fork):** widen `ConfirmationStore` to `MaybePromise` and `await` both call sites; then a Redis
  store (token fingerprint-bound, single-use via GETDEL, TTL) drops in. Until then: multi-instance
  agent-workers must route a confirm retry to the issuing instance (sticky) or run single-instance;
  a stateless HMAC token was considered and REJECTED here (loses single-use semantics — replayable
  within TTL; the idempotency layer masks most but not all of that). The round-trip still maps to the
  platform **approval** outcome (policy-contracts / ADR-019).
- **Metering (T7)** was not exercised — agentback emits a metering stream the
  platform must _aggregate_, not double-count. Open.
- **`build` / `test:dist`** need TS project-reference wiring so `dist/` cross-package
  declarations resolve. The dev loop (typecheck + Vitest-on-`src`) does not need it;
  deferred until the first publish or dist-suite run.

## How to reproduce

```bash
cd hermes-one
pnpm install
pnpm verify        # typecheck + plane-lint + 16 tests (dev, on src)
```
