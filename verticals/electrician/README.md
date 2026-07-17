# Electrician vertical (Pack E)

The **reference vertical**, authored entirely as **data** (ADR-013 — "verticals are data, not code").
Nothing here is industry code: `pack.json` is a data bundle of five substrate definitions plus a
manifest, installed for a tenant through the platform's own admin API (author each definition via
`PUT /v1/definitions/{id}`, then `POST /v1/deployments`). The platform's data-interpreting runtimes
(workflow interpreter, rule runtime, policy runtime, capability registry) execute it — no electrician
code is ever compiled into the platform.

## The bundle (`pack.json`)

| Family | Name | What it does |
|---|---|---|
| workflow | `electrician-intake` | Entry workflow: triage an inbound message via the rule, then hand to the dispatcher agent. |
| rule | `electrician-triage` | Routes the intent (emergency vs schedule). |
| policy | `electrician-safety` | The turn's pre/post gates (permissive baseline). |
| capability | `appointment.slot.read` | Read open service-visit slots (provider-neutral, platform capability). |
| agent-engine | `electrician-dispatcher` | Safety-first dispatcher persona; may use `appointment.slot.read`. |

## Status

- **Slice 1 (done):** the pack installs through the admin API and produces a resolvable **active
  deployment** for a tenant (`pack-e.itest.ts`) — proving the data-driven vertical runtime.
- **Slice 2 (done):** a real inbound turn runs against an electrician tenant on live Temporal + the local
  LLM — the generic host interprets `electrician-intake` → the triage rule routes to the dispatcher agent
  node → a real bounded agent turn completes (`path=[triage,assist,end]`).
- **Slice 3 (done, 2026-07-17) — TOOL-BACKED, verified live:** the dispatcher no longer answers from persona
  alone. `appointment.slot.read` (the specs' canonical platform capability — this pack previously invented
  `electrical.slot.read`, which no seeded role granted) is projected into a real agentback `@tool` whose body
  resolves the ranked `ProviderAdapter`, and `InternalSchedulerProvider` (`infrastructure/scheduler`) serves
  it. A scheduling intent drives the LLM to call the tool → real provider → real slots, recorded in
  `runtime.tool_executions` with `metrics.providerId=internal-scheduler`. An emergency intent correctly
  declines the tool and answers on safety. The **triage rule now decides**: it shipped with literal branches
  that compiled but discriminated nothing; it now reads the `intent` fact, with hazard terms ordered before
  scheduling terms so a caller reporting both is triaged as the emergency (`pack-e-rule.spec.ts`).

## What is still open for this vertical

Tracked in `hermes-one/docs/DEFERRED-AND-FLAGGED.md` (PE1, PE5–PE7):
- **The per-vertical doc set is not authored** (`domain-model.md`, `workflow-catalog.md`, … per
  `docs/implementation/verticals/000-future-verticals-workplan.md`).
- **PE5** — the scheduler provider is a config-driven **stand-in**: slots come from
  `ProviderExecutionContext.config.slotTemplates`, because the canonical 21-table catalog defines no
  appointment/slot table (the prior `appointment_slots` table was removed as an ADR-013 violation). A real
  deployment binds a vendor scheduler behind the same port — which needs the secrets seam (S1/S2/PE7).
- **PE6** — a capability whose `onNoProvider` is `handoff` is not routed to an actual handoff.
- No `VerticalPackController` REST install (the pack installs via `installVerticalPack` / the admin API).

## Installing another vertical

Nothing here is electrician-specific code. `installVerticalPack(pgUrl, redisUrl, tenantId, packPath)`
(`apps/workflow-worker/src/pack-e-install.ts`) walks ANY pack: it authors each definition through
`DefinitionRegistry.put` and publishes via `DeploymentService` — exactly what the admin API's
`PUT /v1/definitions` + `POST /v1/deployments` do. A new vertical is a new `pack.json`, not new code.
