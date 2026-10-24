# Electrician vertical

The **reference vertical**, authored entirely as **data** (ADR-013 — "verticals are data, not code").
Nothing here is industry code: `pack.json` is a data bundle of five substrate definitions plus a
manifest, installed for a tenant through the platform's own admin API (author each definition via
`PUT /v1/definitions/{id}`, then `POST /v1/deployments`). The platform's data-interpreting runtimes
(workflow interpreter, rule runtime, policy runtime, capability registry) execute it — no electrician
code is ever compiled into the platform.

## The bundle (`pack.json`)

| Family       | Name                     | What it does                                                                               |
| ------------ | ------------------------ | ------------------------------------------------------------------------------------------ |
| workflow     | `electrician-intake`     | Entry workflow: triage an inbound message via the rule, hand to the agent, send its reply. |
| rule         | `electrician-triage`     | Routes the intent (emergency vs schedule).                                                 |
| policy       | `electrician-safety`     | The turn's pre/post gates (permissive baseline).                                           |
| capability   | `appointment.slot.read`  | Read open service-visit slots (provider-neutral, platform capability).                     |
| agent-engine | `electrician-dispatcher` | Safety-first dispatcher persona; may use `appointment.slot.read`.                          |

## Status

- **Install (done):** the pack installs through the admin API and produces a resolvable **active
  deployment** for a tenant (`pack-e.itest.ts`) — proving the data-driven vertical runtime.
- **Live turn (done):** a real inbound turn runs against an electrician tenant on live Temporal + the local
  LLM — the generic host interprets `electrician-intake` → the triage rule routes to the dispatcher agent
  node → a real bounded agent turn completes (`path=[triage,assist,end]`).
  Run note: the e2e now also requires `HERMES_CREDENTIALS_MASTER_KEY` (ADR-026 envelope store).
- **Tool-backed turns (done, 2026-07-17), verified live:** the dispatcher answers from real data.
  `appointment.slot.read` — the platform's canonical scheduling capability — is projected into a real
  agentback `@tool` whose body resolves the ranked `ProviderAdapter`, and `InternalSchedulerProvider`
  (`infrastructure/scheduler`) serves it. A scheduling intent drives the LLM to call the tool → real
  provider → real slots, recorded in `runtime.tool_executions` with
  `metrics.providerId=internal-scheduler`. An emergency intent correctly declines the tool and answers
  on safety. The **triage rule reads the real `intent` fact**, bound from the inbound message `text`
  and lowercased, with hazard terms ordered before scheduling terms so a caller reporting both is
  triaged as the emergency (`pack-e-rule.spec.ts`).
- **PE6 (done, 2026-07-17):** a capability whose `onNoProvider` is `handoff` now routes the turn to a
  real handoff — the failed dispatch ends the turn in `handoff` with `error-escalation` in the turn
  ledger handed to persistence (`single-step-turn.spec.ts`).
- **Reply delivery (done, 2026-10-24):** the `assist` agent node declares `deliverReply`, so a
  `replied` turn's final, post-gated reply is sent to the caller through the platform's
  `messaging.reply.send` capability (template `electrician_agent_reply`, recipient
  `{"$input": "from"}`) — one durable outbound `runtime.messages` row per reply. A handoff sends
  nothing.

## What is still open for this vertical

Tracked in [`../../docs/DEFERRED-AND-FLAGGED.md`](../../docs/DEFERRED-AND-FLAGGED.md) (PE1, PE5):

- **The per-vertical doc set is not yet authored** (domain model, workflow catalog, and related
  documents).
- **PE5** — the scheduler provider is a config-driven **placeholder**: slots come from
  `ProviderExecutionContext.config.slotTemplates` (now resolved from the tenant's OWN
  envelope-encrypted credential row — ADR-026, landed 2026-07-17; the e2e proves a tenant `rotate()`
  changes live slot output with zero deploys). A real vendor scheduler binds behind the same
  `ProviderAdapter` port; the credential seam it needed is DONE.
- No `VerticalPackController` REST install (the pack installs via `installVerticalPack` / the admin API).

## Installing another vertical

Nothing here is electrician-specific code. `installVerticalPack(pgUrl, redisUrl, tenantId, packPath)`
(`apps/workflow-worker/src/pack-e-install.ts`) walks ANY pack: it authors each definition through
`DefinitionRegistry.put` and publishes via `DeploymentService` — exactly what the admin API's
`PUT /v1/definitions` + `POST /v1/deployments` do. A new vertical is a new `pack.json`, not new code.
