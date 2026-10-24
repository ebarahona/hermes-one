# Why this architecture

The design decisions in this platform follow from one operating constraint: **an agentic product's
economics and reliability are set by how often it must call a model, and by what happens to work in
flight when a process dies.** Every structural choice below is downstream of that.

Each claim states where it is enforced in code and how it is proven. Governing decisions are
recorded as ADRs in `docs/adr/`.

---

## 1. Deterministic-first routing — the model is not on the hot path

Business logic is authored as **compiled rules and policies**, not as prompt text. The workflow
owns routing and state transitions; a model is consulted only inside a **bounded agent node**, and
only when the deterministic path defers to one.

The consequence is throughput and margin. Messages that a rule can decide never reach a model at
all, so capacity scales with worker count rather than with model concurrency, and the cost of an
additional conversation stays flat instead of tracking token spend. When a model _is_ required, the
call runs on **its own Temporal task queue** — it never blocks the orchestration worker while it
thinks.

_Enforced:_ one workflow interpreter over compiled plan data (ADR-014); rules and policies compile
through `@hermes-one/rule-dsl` and `@hermes-one/policy-dsl` with purity, arity, return-type and depth
checks at compile time. _Proven:_ the deterministic hit rate — the share of turns resolved without a
model call — is computed per tenant by the scalability analytics service; the electrician vertical's
triage routing is decided entirely by the compiled rule.

## 2. Durable execution — work in flight survives

Orchestration runs on Temporal. A workflow's state lives in its event history, not in worker
memory: a workflow worker that crashes mid-run does not lose the run; the workflow rehydrates from
history and continues. An agent turn runs as one activity with `maximumAttempts: 1`, so a crash
mid-turn fails that turn; it is not resumed mid-turn. Workflow nodes that wait (timers, signals such
as a customer's reply) are planned, not built; see the README [Roadmap](../README.md#roadmap).

This is what separates a multi-step business process from a request that happened to succeed.
Retries are classed rather than uniform — guarded writes and model calls are `maxAttempts: 1`, so a
retry can never double-charge or double-send, while transient infrastructure faults retry under
bounded policies.

_Enforced:_ the retry-policy registry in `infrastructure/temporal-client` — six retry classes, generated
non-retryable error types, applied to the activities on both task queues. _Proven:_ end-to-end
flows on a real Temporal server (missed-call and signed webhook in CI; the three-plane triage
manually against a live model), and the integration suite runs twice in CI to catch idempotency
bugs.

## 3. The model proposes; the runtime disposes

A model never calls infrastructure directly and never owns orchestration. It proposes a tool call;
the runtime validates it against a **content-hashed capability contract**, a policy gate decides
whether it may run, the platform resolves a ranked provider, and only then does the effect execute.
Output is stamped as evidence and recorded durably.

Every turn is bounded on steps, deadline, and budget — enforced, not advisory. A reply that a policy
flags is re-composed once under a repair instruction and re-gated; if it still cannot pass, the turn
ends in handoff and records a handoff request rather than delivering unrepaired. The human-handoff
lifecycle after that request is planned; see the README [Roadmap](../README.md#roadmap).

_Enforced:_ propose → gate → execute is single-step, never an autonomous loop; budgets short-circuit
to `failed`. _Proven:_ unit tests drive `runTurn` directly through the repair and handoff paths.

## 4. Multi-tenancy in the substrate, not in application code

Every table that carries a tenant id is scoped by **PostgreSQL row-level security**, enforced at the
database rather than by remembering to add a `WHERE` clause. A fail-closed posture check proves the
connecting role cannot bypass RLS at every composition root that opens a Postgres pool: as a lifecycle
observer in the LoopBack roots, which also probe the tenant GUC, _before_ the process serves anything;
and at the agent worker, before its first turn touches Postgres. A misconfigured deployment refuses to
start (or, at the agent worker, to run a turn) rather than serve cross-tenant data.

Tenants are genuinely independent, not merely partitioned: a tenant can rank **its own provider**
ahead of the platform default and supply **its own credentials**, envelope-encrypted under a
per-tenant key and rotated with a single `rotate()` call.

_Enforced:_ 24 tables and 8 reconciliation views, RLS on the 20 tables that carry a tenant id (the
other four are content-addressed or child substrate tables with no tenant column); views declare
`security_invoker=true` so they cannot bypass it; ADR-026 envelope credential store.
_Proven:_ integration tests assert cross-tenant reads return nothing and admin routes return 403;
a live credential rotation changed the next agent turn's provider output with zero deploys.

## 5. Verticals are data, not code

A new vertical is a **pack file** — workflow, triage rule, policy, capability contract, and agent
engine authored as data and installed through the platform's own admin API. There is no
industry-specific code path, and shipping one requires no deploy.

_Enforced:_ ADR-013; the installer is generic —
`installVerticalPack(pgUrl, redisUrl, tenantId, packPath)`. _Proven:_ the electrician vertical runs a
tool-backed conversation end to end against a live model — the model calls `appointment.slot.read`,
the platform resolves a real provider, and the tool execution is durably recorded with its
`providerId`.

## 6. Typed contracts end to end

Contracts are **Zod-first**: Zod is the single source of truth (generating JSON Schema from it is
planned; capability contracts carry hand-authored JSON Schema today, rebuilt into Zod on the agent
plane).
Definitions are content-hashed and versioned, and a deployment is **pinned** — a running workflow
resolves the exact version it started against, so publishing a new version cannot change the
behavior of work already in flight.

_Enforced:_ ADR-016/020; hash verification on every plan read. _Proven:_ an integration test
supersedes a pinned deployment with a newer version and asserts the pin still resolves unchanged.

## 7. The guarantees are gated, not asserted

Two mechanisms keep the properties above from eroding:

- **An interpreter replay gate in CI.** Committed golden histories replay against every candidate
  interpreter and fail on any nondeterminism. There is no waiver path (ADR-029). The golden
  histories cover the deterministic missed-call workflow; the agent workflow has none yet.
- **A tamper-evident audit trail.** Re-writing an existing audit event with different content is
  refused outright, with no waiver. The guard is load-bearing rather than decorative: it caught an
  event-identity mismatch during development, at the point of writing rather than in production.

Composition is mechanically enforced too: the edge plane and agent plane never share a live context,
and `pnpm plane-lint` (part of `pnpm verify` and CI) fails on a cross-plane runtime import
(ADR-017).

---

## Verified state

Every claim above is exercised by the CI suite (on pull requests and pushes to `main`), plus manual
gates:

| Gate                                       | Result                                                     |
| ------------------------------------------ | ---------------------------------------------------------- |
| Unit suite                                 | 331 passing                                                |
| Integration suite (live PostgreSQL, Redis) | 137 passing, run twice, zero drift                         |
| Interpreter replay gate                    | 3/3 golden histories (missed-call), no nondeterminism      |
| End-to-end on real Temporal                | missed-call · signed webhook (live replay attack rejected) |
| End-to-end, admin API (no backing stack)   | REST surface and API-key authentication                    |
| End-to-end with a live model               | 3-plane triage · the electrician vertical, tool-backed     |
| Typecheck · plane isolation                | 0 errors · no cross-plane imports                          |

`docs/DEFERRED-AND-FLAGGED.md` records the planned increments and every ratified design decision, so
the boundary between what is delivered and what is scheduled is explicit rather than implied.
