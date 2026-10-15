# Contributing to hermes-one

Thanks for your interest in contributing. This guide covers the local setup, the checks every change
must pass, and the conventions the codebase follows.

## Prerequisites

- Node.js ≥ 22.13 and pnpm 11 (`corepack enable` picks up the pinned version)
- Docker, for the local stack (Temporal, PostgreSQL, Redis, Qdrant, OpenTelemetry collector)
- The [Temporal CLI](https://docs.temporal.io/cli), for the replay gate fixtures
- Any OpenAI-compatible LLM endpoint, for the live agent end-to-end runs (see the README)

## Setup

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d
cp .env.example .env    # dev defaults already match the compose stack
pnpm -r build
```

## Before you open a pull request

**Build first.** Tests resolve cross-package imports to each package's `dist/`, so a stale build
produces misleading test results.

```bash
pnpm -r build
pnpm verify                                              # typecheck + plane-lint + unit tests
pnpm lint                                                # eslint + prettier
pnpm test:itest                                          # integration suite (needs the compose stack)
pnpm -F @platform-internal/workflow-worker replay-gate   # if you touched workflow code
```

CI runs the same checks on every push and pull request.

## Conventions

- **Planes stay separate.** The edge plane (LoopBack 4) and the agent plane (agentback) never share a
  live context; they meet only at serializable boundaries (ADR-017). `pnpm plane-lint` enforces this.
- **Ports and adapters.** Components depend on ports; I/O lives only in `infrastructure/`, and adapters
  are wired at composition roots (ADR-024).
- **Contracts are Zod-first** and live in `@platform/contracts` (ADR-020).
- **Verticals are data, not code** (ADR-013). A new vertical is a pack under `verticals/`; code is added
  only for a genuinely new platform capability.
- **Every read and write is tenant-scoped.** New tenant tables need row-level security policies.
- **Workflow changes must stay deterministic.** If you change interpreter control flow, run the replay
  gate and follow the versioning discipline in ADR-029.
- **Deliberate gaps are recorded.** If a change intentionally leaves something unfinished, add a row to
  `docs/DEFERRED-AND-FLAGGED.md` rather than leaving it implicit.
- **Architecture decisions** that change a governing rule are recorded as ADRs in `docs/adr/README.md`.
- **American English** in code, comments, and docs.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `style:`,
`refactor:`, `test:`, `chore:`, with an optional scope, e.g. `fix(channels): ...`.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
