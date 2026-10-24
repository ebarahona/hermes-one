# Contributing to hermes-one

Thanks for your interest in contributing. This guide covers the local setup, the checks every change
must pass, and the conventions the codebase follows.

## Prerequisites

- Node.js ≥ 22.13 and pnpm 11 (`corepack enable` picks up the pinned version)
- Docker, for the local stack (Temporal, PostgreSQL, Redis, Qdrant, OpenTelemetry collector)
- Any OpenAI-compatible LLM endpoint, for the live agent end-to-end runs (see the README)

## Setup

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d
cp .env.example .env    # dev defaults already match the compose stack
pnpm -r build
```

### Git hooks

`pnpm install` runs `scripts/install-hooks.sh`, which installs [lefthook](https://lefthook.dev) hooks
into this clone: eslint and prettier on staged files before each commit, and commitlint on each commit
message. The script never changes your git config. If `core.hooksPath` is already set (for example by
a global configuration), it skips the install and prints how to opt in for this clone only:

```bash
# lefthook (parallel, staged files only)
git config --local core.hooksPath .git/hooks
pnpm exec lefthook install --force

# or the zero-dependency fallback in .githooks/ (sequential, whole tree)
git config --local core.hooksPath .githooks
```

The install is skipped on CI; CI runs the same checks on every pull request.

## Before you open a pull request

**Build first.** Tests resolve cross-package imports to each package's `dist/`, so a stale build
produces misleading test results.

```bash
pnpm -r build
pnpm verify                                              # typecheck + plane-lint + unit tests
pnpm lint                                                # eslint + prettier
pnpm test:itest                                          # integration suite (needs the compose stack)
pnpm -F @hermes-one/workflow-worker replay-gate   # if you touched workflow code
```

CI runs the same checks on every push and pull request.

## Conventions

- **Planes stay separate.** The edge plane (LoopBack 4) and the agent plane (agentback) never share a
  live context; they meet only at serializable boundaries (ADR-017). `pnpm plane-lint` enforces this.
- **Ports and adapters.** Components depend on ports; I/O lives only in `infrastructure/`, and adapters
  are wired at composition roots (ADR-024).
- **Contracts are Zod-first** and live in `@hermes-one/contracts` (ADR-020).
- **Verticals are data, not code** (ADR-013). A new vertical is a pack under `verticals/`; code is added
  only for a genuinely new platform capability.
- **Every read and write is tenant-scoped.** New tenant tables need row-level security policies.
- **Workflow changes must stay deterministic.** If you change interpreter control flow, run the replay
  gate and follow the versioning discipline in ADR-029. Capturing new replay-gate fixtures uses
  `apps/workflow-worker/scripts/capture-replay-fixtures.sh` against the compose stack (it runs the
  Temporal CLI inside the compose container; no local CLI install is needed).
- **Deliberate gaps are recorded.** If a change intentionally leaves something unfinished, add a row to
  `docs/DEFERRED-AND-FLAGGED.md` rather than leaving it implicit.
- **Architecture decisions** that change a governing rule are recorded as ADRs in `docs/adr/README.md`.
- **American English** in code, comments, and docs.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) with an optional scope, e.g.
`fix(channels): ...`. Allowed types: `build`, `chore`, `ci`, `deps`, `docs`, `feat`, `fix`, `perf`,
`refactor`, `revert`, `style`, `test`. commitlint checks every message (`commitlint.config.js`); to
check a branch before pushing, run `pnpm exec commitlint --from origin/main`.

### Developer Certificate of Origin

Every commit must carry a [DCO](https://developercertificate.org/) sign-off, which certifies that you
wrote the change or otherwise have the right to submit it under the project's license. Sign off with
`git commit -s`, which appends a trailer using your configured name and email:

```
feat(rule-runtime): support range conditions

Signed-off-by: Your Name <you@example.com>
```

A pull request check verifies the sign-off on every commit. To add a missing sign-off to the commits
on your branch, run `git rebase --signoff origin/main` and force-push the branch.

## Releases

Releases are cut by [release-please](https://github.com/googleapis/release-please) from the commit
history on `main`. The repository carries a single version, recorded in the root `package.json`. When a
release pull request is merged, release-please tags the release and updates `CHANGELOG.md`. Do not tag
releases or edit `CHANGELOG.md` by hand.

## Coding agents

Conventions for coding agents are in [AGENTS.md](AGENTS.md). Agents follow the same expectations as
human contributors: the checks above, Conventional Commits, and DCO sign-off.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
