# AGENTS.md

This file is read by coding agents per the [agents.md](https://agents.md/) convention. It applies
to every agent regardless of tool, and to human contributors equally.

## Scope

hermes-one (**Hermes ONE**, Orchestration Node Engine) is a multi-tenant platform for vertical agentic
workflows: a deterministic Temporal workflow rail with bounded agent nodes inside it. It is a pnpm
workspace (TypeScript, ESM, Node ≥ 22.13, pnpm 11):

- `apps/` — deployable services and workers (composition roots).
- `components/` — platform components that depend on ports.
- `infrastructure/` — adapters; the only place I/O lives.
- `packages/` — contracts, DSLs, and the definition substrate.
- `verticals/` — vertical packs (data bundles, not workspace packages).
- `tools/` — repository tooling (`plane-lint`).
- `docs/` — architecture rationale, ADRs, build plan, and the deferral ledger.

Repository: https://github.com/ebarahona/hermes-one (MIT License)

## Required reading

Read these before proposing a change:

- [README.md](./README.md) — capabilities, layout, and how to run the stack.
- [docs/WHY-THIS-ARCHITECTURE.md](./docs/WHY-THIS-ARCHITECTURE.md) — the reasoning behind the design.
- [docs/adr/README.md](./docs/adr/README.md) — the ratified decisions code comments cite as `ADR-NNN`.
- [docs/BUILD-PLAN.md](./docs/BUILD-PLAN.md) — the build sequence.
- [docs/DEFERRED-AND-FLAGGED.md](./docs/DEFERRED-AND-FLAGGED.md) — the ledger of open and deliberate gaps.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — setup, checks, and commit conventions.
- [SECURITY.md](./SECURITY.md) — the security model and deployment considerations.

## Workflow expectations

1. Every commit follows [Conventional Commits](https://www.conventionalcommits.org/). Allowed types:
   `build`, `chore`, `ci`, `deps`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`,
   `test`. `commitlint.config.js` enforces this.
2. Every commit carries a DCO sign-off (`git commit -s`).
3. **Build first.** Tests resolve cross-package `@hermes-one/*` imports to each package's `dist/`,
   so run `pnpm -r build` before any test command.
4. Before committing, run:

   ```bash
   pnpm -r build
   pnpm verify                                    # typecheck + plane-lint + unit tests
   pnpm lint                                      # eslint + prettier
   pnpm test:itest                                # integration suite (needs infra/docker-compose.yml)
   pnpm -F @hermes-one/workflow-worker replay-gate   # if workflow or interpreter code changed
   ```

5. Git hooks (lefthook, or the `.githooks/` fallback) run eslint, prettier, and commitlint. Do not
   bypass them with `--no-verify`.

## Architecture rules

- **Two DI planes meet only at serializable boundaries (ADR-017).** The edge plane (`@loopback/*`)
  and the agent plane (`@agentback/*`) never share a live `Context`; they meet across Temporal
  activity I/O, PostgreSQL, and HTTP. `pnpm plane-lint` enforces this.
- **Ports and adapters (ADR-024).** Components depend on interfaces, never on implementations. I/O
  lives only in `infrastructure/`; adapters are wired at composition roots in `apps/`.
- **Contracts are Zod-first (ADR-020).** Zod is the single source of truth. Generating JSON Schema
  and OpenAPI from it is planned; never hand-maintain a parallel schema for a Zod contract.
- **Every read and write is tenant-scoped.** New tenant tables ship with row-level security
  policies.
- **Verticals are data, not code (ADR-013).** A new vertical is a pack under `verticals/`. Code is
  added only for a genuinely new platform capability.
- **One interpreter; workflows are deterministic (ADR-014, ADR-029).** There is exactly one
  workflow interpreter, and it walks compiled plan data. Interpreter changes must pass the replay
  gate. Never hand-edit the golden histories in `apps/workflow-worker/test/replay-fixtures/`; they
  are captured with `apps/workflow-worker/scripts/capture-replay-fixtures.sh` and kept byte-exact.
- **Deliberate gaps are recorded.** A change that intentionally leaves something unfinished adds a
  row to `docs/DEFERRED-AND-FLAGGED.md`.
- **Governing decisions are ADRs.** A change to a governing rule is recorded in
  `docs/adr/README.md`.
- **American English** in code, comments, and docs.

## What not to do

- Do not modify global git config; scope any override to this clone with `--local`.
- Do not hand-write `CHANGELOG.md`; release-please owns it.
- Do not put business logic in prompt text; it belongs in compiled rules and policies.
- Do not file security reports as public issues.

## Contact

- Issues: https://github.com/ebarahona/hermes-one/issues
- Security: https://github.com/ebarahona/hermes-one/security/advisories/new (see
  [SECURITY.md](./SECURITY.md))
- Code of conduct: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) (Contributor Covenant 2.1)
