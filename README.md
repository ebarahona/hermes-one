# hermes-one

**Hermes Orchestration Node Engine** — the agentic workflow platform monorepo.

A deterministic Temporal workflow rail with bounded agent nodes inside it. The
workflow owns orchestration; the agent owns bounded reasoning; the model proposes,
the runtime disposes. See `../docs/PROJECT-CONTEXT.md` for the platform thesis and
`docs/adr/` for the ratified architecture decisions this code is governed by.

## Layout (five areas)

| Area              | Role                                                 | Scope                  |
| ----------------- | ---------------------------------------------------- | ---------------------- |
| `apps/`           | deployable processes (one DI container each)         | `@platform-internal/*` |
| `packages/`       | pure libraries — schemas, compilers, plan types, SDK | `@platform/*`          |
| `components/`     | DI-wired engines (depend on ports, not adapters)     | `@platform-internal/*` |
| `infrastructure/` | I/O adapters (the only place with I/O)               | `@platform-internal/*` |
| `verticals/`      | **data** bundles (not workspace packages)            | —                      |

The edge/data plane (`@loopback/*`) and the agent plane (`@agentback/*`) never
share a live DI `Context`; they meet only at serializable boundaries (ADR-017).
`pnpm plane-lint` enforces this.

## Toolchain

pnpm 11 workspace · ESM · Node ≥22.13 · TypeScript 5.7 · Zod (ADR-020) · Vitest.

## Commands

```bash
pnpm install
pnpm verify        # typecheck + plane-lint + test — the CI gate
pnpm typecheck     # one whole-repo program, cross-package types from src
pnpm plane-lint    # two-plane isolation check (ADR-017)
pnpm test          # Vitest against src/ (fast dev loop)
pnpm test:watch
pnpm test:dist     # build, then run the suite against built dist/ (post-dev)
```

**Testing model:** development tests run against **`src/`** (Vitest transpiles on
the fly — no build). A full suite runs against built **`dist/`** after development
via `pnpm test:dist`.

## Status

The monorepo skeleton (34 workspace members + the electrician data vertical) is
coherent — `pnpm verify` is green. The first real code is the **agent-plane
de-risking spike**: `components/agentback-runtime` + `tool-executor` +
`agent-runtime` validate agentback `0.7.1` against ADR-017/018/021. See
`docs/SPIKE-FINDINGS.md`.
