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
additional conversation stays flat instead of tracking token spend. When a model *is* required, the
call runs on **its own Temporal task queue** — it never blocks the orchestration worker while it
thinks.

*Enforced:* one workflow interpreter over compiled plan data (ADR-014); rules and policies compile
through `@platform/workflow-dsl` with purity, arity, return-type and depth checks at compile time.
*Proven:* the deterministic hit rate — the share of turns resolved without a model call — is computed
per tenant and surfaced on the scalability dashboard; the electrician vertical's emergency intent
resolves live with `toolCalls=0`, and its triage routing is decided entirely by the compiled rule.

## 2. Durable execution — work in flight survives

Orchestration runs on Temporal. A workflow that is waiting three days for a customer to reply holds
**zero** worker capacity while it waits, and resumes exactly where it left off. A process that
crashes mid-run does not lose the run; the workflow rehydrates from history and continues.

This is what separates a multi-step business process from a request that happened to succeed.
Retries are classed rather than uniform — guarded writes and model calls are `maxAttempts: 1`, so a
retry can never double-charge or double-send, while transient infrastructure faults retry freely.

*Enforced:* `temporal/retry-policy-registry` transcribed verbatim — six retry classes, generated
non-retryable error types, applied at both workers. *Proven:* three end-to-end flows on a real
Temporal server, each re-run to confirm idempotency.

## 3. The model proposes; the runtime disposes

A model never calls infrastructure directly and never owns orchestration. It proposes a tool call;
the runtime validates it against a **content-hashed capability contract**, a policy gate decides
whether it may run, the platform resolves a ranked provider, and only then does the effect execute.
Output is stamped as evidence and recorded durably.

Every turn is bounded on steps, deadline, and budget — enforced, not advisory. A reply that a policy
flags is re-composed once under a repair instruction and re-gated; if it still cannot pass, the turn
escalates to a human rather than delivering unrepaired.

*Enforced:* propose → gate → execute is single-step, never an autonomous loop; budgets short-circuit
to `failed`. *Proven:* unit tests drive `runTurn` directly through the repair and handoff paths.

## 4. Multi-tenancy in the substrate, not in application code

Every read and write is tenant-scoped by **PostgreSQL row-level security**, enforced at the database
rather than by remembering to add a `WHERE` clause. A fail-closed posture check proves the connecting
role cannot bypass RLS — and probes the tenant GUC — at every composition root that touches Postgres,
*before* the process serves anything (ADR-022): as a lifecycle observer in the LoopBack roots, and
directly at the agent worker. A misconfigured deployment refuses to start rather than serve
cross-tenant data.

Tenants are genuinely independent, not merely partitioned: a tenant can rank **its own provider**
ahead of the platform default and supply **its own credentials**, envelope-encrypted under a
per-tenant key and rotated with a single `rotate()` call.

*Enforced:* 24 tables and 8 reconciliation views, RLS on every tenant-owned table; views declare
`security_invoker=true` so they cannot bypass it; ADR-026 envelope credential store.
*Proven:* integration tests assert cross-tenant reads return nothing and admin routes return 403;
a live credential rotation changed the next agent turn's provider output with zero deploys.

## 5. Verticals are data, not code

A new vertical is a **pack file** — workflow, triage rule, policy, capability contract, and agent
engine authored as data and installed through the platform's own admin API. There is no
industry-specific code path, and shipping one requires no deploy.

*Enforced:* ADR-013; the installer is generic —
`installVerticalPack(pgUrl, redisUrl, tenantId, packPath)`. *Proven:* the electrician vertical runs a
tool-backed conversation end to end against a live model — the model calls `appointment.slot.read`,
the platform resolves a real provider, and the slot is durably recorded with its `providerId`.

## 6. Typed contracts end to end

Contracts are **Zod-first**; JSON Schema is generated from them, never hand-maintained alongside.
Definitions are content-hashed and versioned, and a deployment is **pinned** — a running workflow
resolves the exact version it started against, so publishing a new version cannot change the
behavior of work already in flight.

*Enforced:* ADR-016/020; hash verification on every plan read. *Proven:* an integration test
supersedes a deployment mid-flight and asserts the pin survives.

## 7. The guarantees are gated, not asserted

Two mechanisms keep the properties above from eroding:

- **An interpreter replay gate in CI.** Committed golden histories replay against every candidate
  interpreter and fail on any nondeterminism. There is no waiver path (ADR-029).
- **A tamper-evident audit trail.** Re-writing an existing audit event with different content is
  refused outright, with no waiver. The guard is load-bearing rather than decorative: it caught an
  event-identity mismatch during development, at the point of writing rather than in production.

Composition is mechanically enforced too: the edge plane and agent plane never share a live context,
and `pnpm plane-lint` fails the build on a cross-plane import (ADR-017).

---

## Verified state

Every claim above is exercised by the suite that runs on each push, plus manual live-model gates:

| Gate | Result |
| --- | --- |
| Unit suite | 268 passing |
| Integration suite (live PostgreSQL, Redis) | 136 passing, run twice, zero drift |
| Interpreter replay gate | 3/3 golden histories, no nondeterminism |
| End-to-end on real Temporal | missed-call · signed webhook (live replay attack rejected) · admin API |
| End-to-end with a live model | 3-plane triage · the electrician vertical, tool-backed |
| Typecheck · plane isolation | 0 errors · no cross-plane imports |

`docs/DEFERRED-AND-FLAGGED.md` records the planned increments and every ratified spec decision, so
the boundary between what is delivered and what is scheduled is explicit rather than implied.
