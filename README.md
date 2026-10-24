# hermes-one

**Hermes Orchestration Node Engine** — a multi-tenant platform for vertical agentic workflows.

A deterministic Temporal workflow rail with bounded agent nodes inside it. The workflow owns
orchestration; the agent owns bounded reasoning; **the model proposes, the runtime disposes** —
every tool the model calls passes a policy gate, every side effect carries an idempotency key, every
tenant-owned table is scoped by row-level security, and every turn is durably recorded for replay,
audit, and evaluation. The reasoning behind these choices is in **`docs/WHY-THIS-ARCHITECTURE.md`**; governing
decisions live in `docs/adr/`; the build sequence in `docs/BUILD-PLAN.md`.

> **Status: pre-1.0.** The core platform runs end to end and is covered by unit, integration,
> replay, and end-to-end tests. Interfaces may still change between minor versions. What is planned
> but not built yet is listed under [Roadmap](#roadmap); open work is tracked in
> `docs/DEFERRED-AND-FLAGGED.md`; deployment boundaries are listed in `SECURITY.md`.

## Capabilities

- **Verticals are data, not code (ADR-013) — proven live.** The electrician vertical is a single
  `pack.json` (workflow, triage rule, policy, capability, agent engine). It installs through the
  platform's own admin API (`apps/admin-api/src/pack-e.itest.ts`), and a live LLM turn on real
  Temporal (`apps/agent-worker/src/pack-e.e2e.ts`, which installs the same definitions in-process)
  yields a **tool-backed agent conversation** — the model calls `appointment.slot.read`, the
  platform resolves a ranked provider, and the result is durably recorded. A new vertical is a new pack file, not a deploy.
  Two verticals ship in `verticals/`: a residential electrician (`electrician/`) and support-ticket
  triage (`support/`), where rules answer or escalate most messages and the model is called only
  for a message that needs judgment.
- **Bring-your-own-vendor multi-tenancy.** A tenant can rank its **own provider** first
  (`capability.provider_mappings`, admin-managed) and supply its **own credentials**
  (envelope-encrypted per tenant, rotated with a single `rotate()` call) — zero deploys, proven live:
  one credential rotation changes the next agent turn's provider behavior.
- **An admin control-plane API.** OIDC + API-key auth on a fail-closed LoopBack 4 sequence;
  role-resolved, tenant-scoped, RLS-enforced routes for tenants, users, roles, definitions,
  deployments (author → preview → publish → rollback), and provider-mapping overrides. There is no
  admin UI yet (see [Roadmap](#roadmap)).
- **Durable truth, transactionally.** Turn ledgers, audit events, usage metering, and outbox
  envelopes commit in single tenant-scoped transactions (commit-and-publish). The audit trail is
  **tamper-evident** (append-only, with a per-event integrity hash): re-writing an existing event is refused, and replay-stable clocks make
  legitimate re-execution idempotent.
- **An interpreter replay gate in CI.** There is exactly ONE workflow interpreter (ADR-014);
  every build replays committed golden histories against it and fails on any nondeterminism —
  no waiver path (ADR-029). The committed histories cover the deterministic workflow today; agent
  workflow histories are on the roadmap.
- **Observability end-to-end.** OpenTelemetry distributed tracing across the Temporal boundary
  (edge → activity → agent turn → tool), structured PII-redacting logs for agent turns, and an
  evaluation harness wired into deployment publish as a regression gate. Cost and scalability
  analytics services exist as components but are not yet wired into an app.

## Architecture

Two DI planes that never share a live context: the **edge plane** on LoopBack 4 and the **agent
plane** on agentback — authored by the creator of LoopBack (the original framework and LoopBack 4),
so one proven IoC idiom spans both planes. They meet only at serializable boundaries (ADR-017),
enforced mechanically by `pnpm plane-lint`. Everything configurable is a content-hashed, versioned
definition (Zod-first contracts, ADR-016/020); everything durable is Temporal (ADR-014); every
dependency is a port with adapters wired only at composition roots (ADR-024). The agent-plane
substrate was qualified against the architecture's contracts with executable tests before adoption —
see `docs/SPIKE-FINDINGS.md`.

## Layout

| Area              | Role                                                       |
| ----------------- | ---------------------------------------------------------- |
| `apps/`           | deployable processes, one composition root each            |
| `packages/`       | pure libraries — schemas, compilers, plan types            |
| `components/`     | DI-wired engines (depend on ports, not adapters)           |
| `infrastructure/` | I/O adapters (the only place with I/O)                     |
| `verticals/`      | **data** bundles (not workspace packages)                  |
| `infra/`          | the local Docker Compose stack and collector configuration |
| `tools/`          | repository tooling (`plane-lint`)                          |

All workspace packages use the `@hermes-one/*` scope.

## Toolchain

pnpm 11 workspace · ESM · Node ≥22.13 · TypeScript 5.7 · Zod (ADR-020) · Vitest · Temporal ·
PostgreSQL (RLS) · Redis · OpenTelemetry. Qdrant runs in the local stack, reserved for the planned
knowledge retrieval.

## Commands

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d   # Temporal + Postgres + Redis + Qdrant + OTel

pnpm -r build      # build FIRST (tests resolve cross-package imports to dist)
pnpm verify        # typecheck + plane-lint + unit tests — the CI gate
pnpm test:itest    # integration suite against the live stack (RLS, atomicity, routes)
pnpm -F @hermes-one/workflow-worker replay-gate   # interpreter nondeterminism gate (ADR-029)

node apps/workflow-worker/dist/e2e.js   # missed-call flow on real Temporal
node apps/api-gateway/dist/e2e.js       # signed webhook → workflow (replay-attack rejected live)
node apps/agent-worker/dist/e2e.js      # 3-plane triage with a live LLM (see "LLM configuration")

# the electrician vertical, end to end, tool-backed. Needs HERMES_CREDENTIALS_MASTER_KEY in the
# environment (ADR-026 envelope store): the run resolves the tenant's OWN credentials and fails
# closed rather than falling back to platform defaults.
cp .env.example .env   # once; then set HERMES_CREDENTIALS_MASTER_KEY in it
set -a; . ./.env; set +a
node apps/agent-worker/dist/pack-e.e2e.js

# the support-ticket triage vertical: rule-answered, rule-escalated, and agent-handled messages
node apps/agent-worker/dist/support-pack.e2e.js
```

## LLM configuration

The model client speaks the OpenAI-compatible chat API, so any compatible endpoint works. Set three
variables in `.env`:

```bash
# OpenAI
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=<model name>
LLM_API_KEY=<your key>

# Local: Ollama, llama.cpp (llama-server), vLLM, LM Studio, or any OpenAI-compatible server
LLM_BASE_URL=http://127.0.0.1:11434/v1   # Ollama's default; llama-server defaults to :8080/v1
LLM_MODEL=<model name>
LLM_API_KEY=local
```

The model must support tool calling for the tool-backed agent flows. A provider with a different API
is added as a `SingleStepModel` adapter in `infrastructure/model-client`.

## Engineering discipline

Every intentional deferral and design deviation is recorded in `docs/DEFERRED-AND-FLAGGED.md` — nothing
is silently improvised. The architecture is the source of truth; where a library or a second architectural constraint genuinely
conflicts, the conflict is ratified as an ADR (`docs/adr/`), never resolved ad hoc. CI runs the
typecheck, the plane-isolation lint, the unit and integration suites, and the interpreter replay
gate on every pull request and every push to `main`.

## Roadmap

Planned, not built yet. Contributions are welcome; open an issue to discuss an item first.

- **CLI** to validate, install, and publish vertical packs.
- **Typed SDK** for the admin API.
- **Testkit** for pack authors: evaluate rules and simulate conversations without the full stack.
- **Knowledge retrieval**: vector search over a tenant's documents (Qdrant, ADR-007).
- **Admin web UI** over the existing admin API.
- **More workflow node kinds**: `wait`, `signalWait`, `branch`, `parallel`/`join`, and child
  workflows. The contracts define them; the interpreter rejects them today ("not supported in this
  build").
- **Human handoff lifecycle**: claim, resolve, and resume a conversation handed off to a person.
  Handoff is recorded today (durable `handoff_tasks` rows from agent turns); the lifecycle around
  it is not built.
- **Replay fixtures for the agent workflow**, alongside the existing deterministic-workflow fixtures.
- **Channels beyond SMS**: WhatsApp, webchat, email, voice, and `api` are in the `Channel` contract; only
  the SMS transport is implemented.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
