# Contributing to hermes-one

Thanks for helping out. This guide covers local setup, the checks every change has to pass, and the
conventions the code follows.

## Prerequisites

- Node.js ≥ 22.13 and pnpm 11 (`corepack enable` picks up the pinned version)
- Docker, for the local stack (Temporal, PostgreSQL, Redis, Qdrant, OpenTelemetry collector)
- Optional: an OpenAI-compatible LLM endpoint, to run the agent end-to-end tests against a real model.
  Without one, use `pnpm mock-llm` (see the README)

## Setup

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d
cp .env.example .env    # dev defaults already match the compose stack
pnpm -r build
```

### Git hooks

`pnpm install` runs `scripts/install-hooks.sh`, which installs [lefthook](https://lefthook.dev) hooks
in this clone. Before each commit they run eslint and prettier on staged files, and commitlint checks
each commit message. The script never changes your git config. If `core.hooksPath` is already set
(by a global config, for example), it skips the install and prints how to opt in for this clone only:

```bash
# lefthook (parallel, staged files only)
git config --local core.hooksPath .git/hooks
pnpm exec lefthook install --force

# or the zero-dependency fallback in .githooks/ (sequential, whole tree)
git config --local core.hooksPath .githooks
```

The install is skipped on CI. CI runs eslint and prettier on every pull request. It does not run
commitlint.

## Before you open a pull request

Build first. Tests resolve cross-package imports to each package's `dist/`, so a stale build gives
you misleading test results.

```bash
pnpm -r build
pnpm verify                                              # typecheck + plane-lint + unit tests
pnpm lint                                                # eslint + prettier
pnpm test:itest                                          # integration suite (needs the compose stack)
pnpm -F @hermes-one/workflow-worker replay-gate   # if you touched workflow code
```

CI runs the same checks on pull requests and on pushes to `main`.

## Conventions

- Keep the planes separate. The edge plane (LoopBack 4) and the agent plane (agentback) never share a
  live context. They meet only at serializable boundaries (ADR-017), and `pnpm plane-lint` enforces
  this.
- Use ports and adapters. Components depend on ports. I/O lives only in `infrastructure/`, and
  adapters are wired at composition roots (ADR-024).
- Contracts are Zod-first and live in `@hermes-one/contracts` (ADR-020).
- Verticals are data (ADR-013). A new vertical is a pack under `verticals/`. Add code only for a
  genuinely new platform capability.
- Every read and write is tenant-scoped. New tenant tables need row-level security policies.
- Workflow changes must stay deterministic. If you change interpreter control flow, run the replay
  gate and follow the versioning rules in ADR-029. To capture new replay-gate fixtures, run
  `apps/workflow-worker/scripts/capture-replay-fixtures.sh` against the compose stack. It runs the
  Temporal CLI inside the compose container, so you don't need to install the CLI locally.
- Write down deliberate gaps. If a change leaves something unfinished on purpose, add a row to
  `docs/DEFERRED-AND-FLAGGED.md` so it isn't left implicit.
- A change to a governing rule gets an ADR in `docs/adr/README.md`.
- Use American English in code, comments, and docs.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) with an optional scope, for example
`fix(channels): ...`. Allowed types: `build`, `chore`, `ci`, `deps`, `docs`, `feat`, `fix`, `perf`,
`refactor`, `revert`, `style`, `test`. commitlint checks every message (`commitlint.config.js`). To
check a branch before you push, run `pnpm exec commitlint --from origin/main`.

### Developer Certificate of Origin

Every commit needs a [DCO](https://developercertificate.org/) sign-off. It certifies that you wrote
the change or otherwise have the right to submit it under the project's license. Sign off with
`git commit -s`, which adds a trailer with your configured name and email:

```
feat(rule-dsl): support range conditions

Signed-off-by: Your Name <you@example.com>
```

A pull request check verifies the sign-off on every commit. If commits on your branch are missing
it, run `git rebase --signoff origin/main` and force-push the branch.

## Releases

[release-please](https://github.com/googleapis/release-please) cuts releases from the commit history
on `main`. The repo has a single version, kept in the root `package.json`. When a release pull
request is merged, release-please tags the release and updates `CHANGELOG.md`. Don't tag releases or
edit `CHANGELOG.md` by hand.

## Coding agents

Rules for coding agents are in [AGENTS.md](AGENTS.md). Agents meet the same bar as human
contributors: the checks above, Conventional Commits, and DCO sign-off.

## Reporting security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
