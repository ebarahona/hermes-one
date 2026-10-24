# Why this architecture

Most of the design here comes from one constraint. **What an agentic product costs, and how reliable
it is, depends on how often it has to call a model and on what happens to in-flight work when a
process dies.** Every structural choice below follows from that.

Each point says where the code enforces it and how it's proven. The decisions behind them are
recorded as ADRs in `docs/adr/`.

---

## 1. Deterministic-first routing: the model is off the hot path

Business logic is written as **compiled rules and policies** instead of prompt text. The workflow
owns routing and state transitions. A model only gets consulted inside a **bounded agent node**, and
only when the deterministic path hands off to one.

That's where the throughput and margin come from. A message that a rule can decide never reaches a model. So
capacity scales with the number of workers instead of with model concurrency, and the cost of one
more conversation stays flat instead of tracking token spend. When a model _is_ needed, the call
runs on **a separate Temporal task queue**, so it never blocks the orchestration worker while it
thinks.

_Enforced:_ one workflow interpreter over compiled plan data (ADR-014). Rules and policies compile
through `@hermes-one/rule-dsl` and `@hermes-one/policy-dsl`, with purity, arity, return-type and
depth checks at compile time. _Proven:_ the scalability analytics service computes the deterministic
hit rate per tenant (the share of turns resolved without a model call). The electrician vertical's
triage routing is decided entirely by the compiled rule.

## 2. Durable execution: in-flight work survives

Orchestration runs on Temporal. A workflow's state lives in its event history instead of in worker
memory. If a workflow worker crashes mid-run, the run isn't lost: the workflow rehydrates from
history and keeps going. An agent turn runs as one activity with `maximumAttempts: 1`, so a crash
mid-turn fails that turn. It doesn't resume halfway. Workflow nodes that wait (timers, or signals
such as a customer's reply) are planned but not built yet. See the README
[Roadmap](../README.md#roadmap).

This is the difference between a multi-step business process and a request that happened to
succeed. Retries are split into classes instead of using one policy. Guarded writes and model calls
are `maxAttempts: 1`, so a retry can't double-charge or double-send. Transient infrastructure faults
retry under bounded policies.

_Enforced:_ the retry-policy registry in `infrastructure/temporal-client`. It has six retry classes
and generated non-retryable error types, and it's applied to the activities on both task queues.
_Proven:_ end-to-end flows on a real Temporal server (missed-call and signed webhook in CI, plus the
agent flows, which CI runs against a scripted mock model and you can run against a real one). The integration suite also runs twice in CI
to catch idempotency bugs.

## 3. The model proposes, the runtime decides

A model never calls infrastructure directly and never owns orchestration. It proposes a tool call.
The runtime validates that call against a **content-hashed capability contract**, a policy gate
decides whether it can run, and the platform resolves a ranked provider. Only then does the effect
run. The output is stamped as evidence and recorded durably.

Every turn has hard limits on steps, deadline and budget. They're enforced, not just suggested. If a
policy flags a reply, the reply gets composed again once under a repair instruction and goes back
through the gate. If it still can't pass, the turn ends in handoff and records a handoff request
instead of sending the unrepaired reply. The human-handoff lifecycle after that request is planned.
See the README [Roadmap](../README.md#roadmap).

_Enforced:_ propose → gate → execute is a single step, never an autonomous loop. Budgets
short-circuit to `failed`. _Proven:_ unit tests drive `runTurn` directly through the repair and
handoff paths.

## 4. Multi-tenancy lives in the database

Every table that carries a tenant id is scoped by **PostgreSQL row-level security**. The database
enforces it, so nobody has to remember a `WHERE` clause. A fail-closed setup check proves the
connecting role can't bypass RLS, and it runs at every composition root that opens a Postgres pool.
In the LoopBack roots it's a lifecycle observer that also probes the tenant GUC, and it runs
_before_ the process serves anything. At the agent worker it runs before the first turn touches
Postgres. A misconfigured deployment refuses to start (or, at the agent worker, to run a turn)
instead of serving cross-tenant data.

Tenants get more than separate data. A tenant can rank
**its own provider** ahead of the platform default and supply **its own credentials**. Those are
envelope-encrypted under a per-tenant key and rotated with a single `rotate()` call.

_Enforced:_ 24 tables and 8 reconciliation views. RLS is on the 20 tables that carry a tenant id. The
other four are content-addressed tables or child tables with no tenant column.
Views declare `security_invoker=true` so they can't bypass RLS. Credentials use the ADR-026 envelope
credential store. _Proven:_ integration tests assert that cross-tenant reads return nothing and
that admin routes return 403. A live credential rotation changed the next agent turn's provider
output with zero deploys.

## 5. Verticals are data

A new vertical is a **pack file**: workflow, triage rule, policy, capability contract and agent
engine, all written as data and installed through the platform's own admin API. There's no
industry-specific code path, and shipping a vertical doesn't need a deploy.

_Enforced:_ ADR-013. The installer is generic:
`installVerticalPack(pgUrl, redisUrl, tenantId, packPath)`. _Proven:_ the electrician vertical runs
a tool-backed conversation end to end against a live model. The model calls
`appointment.slot.read`, the platform resolves a real provider, and the tool execution is durably
recorded with its `providerId`.

## 6. Typed contracts end to end

Contracts are **Zod-first**, and Zod is the single source of truth. Generating JSON Schema from Zod
is planned. Today, capability contracts carry hand-written JSON Schema, which gets rebuilt into Zod
on the agent plane. Definitions are content-hashed and versioned, and a deployment is **pinned**. A
running workflow resolves the exact version it started on, so publishing a new version can't change
the behavior of work that's already in flight.

_Enforced:_ ADR-016/020, plus hash verification on every plan read. _Proven:_ an integration test
supersedes a pinned deployment with a newer version and asserts the pin still resolves unchanged.

## 7. The guarantees are checked by gates

Two mechanisms keep the properties above from wearing away:

- **An interpreter replay gate in CI.** Committed golden histories replay against every candidate
  interpreter, and the gate fails on any nondeterminism. There's no way to waive it (ADR-029). The
  golden histories cover the deterministic missed-call workflow. The agent workflow doesn't have
  any yet.
- **A tamper-evident audit trail.** Rewriting an existing audit event with different content is
  refused outright, with no waiver. The guard does real work: during development it caught an
  event-identity mismatch at write time, before it could reach production.

Composition is checked mechanically too. The edge plane and agent plane never share a live context,
and `pnpm plane-lint` (part of `pnpm verify` and CI) fails on any cross-plane runtime import
(ADR-017).

---

## Verified state

The CI suite (on pull requests and pushes to `main`) exercises every claim above. Runs against a
real model are manual:

| Gate                                       | Result                                                     |
| ------------------------------------------ | ---------------------------------------------------------- |
| Unit suite                                 | 336 passing                                                |
| Integration suite (live PostgreSQL, Redis) | 137 passing, run twice, zero drift                         |
| Interpreter replay gate                    | 3/3 golden histories (missed-call), no nondeterminism      |
| End-to-end on real Temporal                | missed-call · signed webhook (live replay attack rejected) |
| End-to-end, admin API (PostgreSQL)         | REST surface and API-key authentication                    |
| End-to-end agent flows, mock model (CI)    | 3-plane triage · support pack · electrician, tool-backed   |
| End-to-end with a real model (manual)      | the same flows, pointed at any OpenAI-compatible endpoint  |
| Typecheck · plane isolation                | 0 errors · no cross-plane imports                          |

`docs/DEFERRED-AND-FLAGGED.md` lists the planned increments and every design decision that's been
signed off, so it's clear what's delivered and what's still scheduled.
