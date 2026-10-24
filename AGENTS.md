# AGENTS.md

Coding agents read this file under the [agents.md](https://agents.md/) convention. It applies to
every agent, whatever the tool, and to human contributors too.

## Scope

hermes-one (**Hermes Orchestration Node Engine**) is a multi-tenant platform for vertical agentic
workflows. A deterministic Temporal workflow is the main path, and bounded agent nodes run inside
it. It is a pnpm workspace (TypeScript, ESM, Node ≥ 22.13, pnpm 11):

- `apps/`: deployable services and workers (composition roots).
- `components/`: platform components that depend on ports.
- `infrastructure/`: adapters. This is the only place I/O lives.
- `packages/`: contracts, DSLs, and `definition-substrate`.
- `verticals/`: vertical packs (data bundles, not workspace packages).
- `tools/`: repo tooling (`plane-lint`).
- `docs/`: architecture rationale, ADRs, build plan, and the deferral ledger.

Repository: https://github.com/ebarahona/hermes-one (MIT License)

## Required reading

Read these before you propose a change:

- [README.md](./README.md): what it does, the layout, and how to run the stack.
- [docs/WHY-THIS-ARCHITECTURE.md](./docs/WHY-THIS-ARCHITECTURE.md): why the design looks the way it
  does.
- [docs/adr/README.md](./docs/adr/README.md): the accepted decisions that code comments cite as
  `ADR-NNN`.
- [docs/BUILD-PLAN.md](./docs/BUILD-PLAN.md): the build order.
- [docs/DEFERRED-AND-FLAGGED.md](./docs/DEFERRED-AND-FLAGGED.md): the ledger of open and deliberate
  gaps.
- [CONTRIBUTING.md](./CONTRIBUTING.md): setup, checks, and commit conventions.
- [SECURITY.md](./SECURITY.md): the security model and deployment considerations.

## Workflow expectations

1. Every commit follows [Conventional Commits](https://www.conventionalcommits.org/). Allowed types:
   `build`, `chore`, `ci`, `deps`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`,
   `test`. `commitlint.config.js` enforces this.
2. Every commit has a DCO sign-off (`git commit -s`).
3. Build first. Tests resolve cross-package `@hermes-one/*` imports to each package's `dist/`, so
   run `pnpm -r build` before any test command.
4. Before committing, run:

   ```bash
   pnpm -r build
   pnpm verify                                    # typecheck + plane-lint + unit tests
   pnpm lint                                      # eslint + prettier
   pnpm test:itest                                # integration suite (needs infra/docker-compose.yml)
   pnpm -F @hermes-one/workflow-worker replay-gate   # if workflow or interpreter code changed
   ```

5. Git hooks (lefthook, or the `.githooks/` fallback) run eslint, prettier, and commitlint. Don't
   bypass them with `--no-verify`.

## Architecture rules

- The two DI planes meet only at serializable boundaries (ADR-017). The edge plane (`@loopback/*`)
  and the agent plane (`@agentback/*`) never share a live `Context`. They meet across Temporal
  activity I/O, PostgreSQL, and HTTP. `pnpm plane-lint` enforces this.
- Ports and adapters (ADR-024). Components depend on interfaces, never on implementations. I/O
  lives only in `infrastructure/`. Adapters are wired at composition roots in `apps/`.
- Contracts are Zod-first (ADR-020). Zod is the single source of truth. Generating JSON Schema and
  OpenAPI from it is planned. Never hand-maintain a parallel schema for a Zod contract.
- Every read and write is tenant-scoped. New tenant tables ship with row-level security policies.
- Verticals are data (ADR-013). A new vertical is a pack under `verticals/`. Add code only for a
  genuinely new platform capability.
- There is one interpreter, and workflows are deterministic (ADR-014, ADR-029). Exactly one workflow
  interpreter exists, and it walks compiled plan data. Interpreter changes must pass the replay gate.
  Never hand-edit the golden histories in `apps/workflow-worker/test/replay-fixtures/`. They are
  captured with `apps/workflow-worker/scripts/capture-replay-fixtures.sh` and kept byte-exact.
- Record deliberate gaps. A change that leaves something unfinished on purpose adds a row to
  `docs/DEFERRED-AND-FLAGGED.md`.
- Governing decisions are ADRs. A change to a governing rule is recorded in `docs/adr/README.md`.
- Use American English in code, comments, and docs.

## What not to do

- Don't modify global git config. Scope any override to this clone with `--local`.
- Don't hand-write `CHANGELOG.md`. release-please owns it.
- Don't put business logic in prompt text. It belongs in compiled rules and policies.
- Don't file security reports as public issues.

## Contact

- Issues: https://github.com/ebarahona/hermes-one/issues
- Security: https://github.com/ebarahona/hermes-one/security/advisories/new (see
  [SECURITY.md](./SECURITY.md))
- Code of conduct: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) (Contributor Covenant 2.1)
