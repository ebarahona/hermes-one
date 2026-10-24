# Electrician vertical

This is the reference vertical, and it is written entirely as data (ADR-013, "verticals are data").
There is no industry code here. `pack.json` is a data bundle of five definitions plus a manifest. You
install it for a tenant through the platform's own admin API: author each definition with
`PUT /v1/definitions/{id}`, then call `POST /v1/deployments`. The platform's data-interpreting
runtimes (workflow interpreter, rule runtime, policy runtime, capability registry) run it. No
electrician code is ever compiled into the platform.

## The bundle (`pack.json`)

| Family       | Name                     | What it does                                                                                   |
| ------------ | ------------------------ | ---------------------------------------------------------------------------------------------- |
| workflow     | `electrician-intake`     | Entry workflow: triage an inbound message with the rule, hand it to the agent, send its reply. |
| rule         | `electrician-triage`     | Routes the intent (emergency or schedule).                                                     |
| policy       | `electrician-safety`     | The turn's pre and post gates (permissive baseline).                                           |
| capability   | `appointment.slot.read`  | Reads open service-visit slots (provider-neutral platform capability).                         |
| agent-engine | `electrician-dispatcher` | Safety-first dispatcher persona. Can use `appointment.slot.read`.                              |

## Status

- Install (done): the pack installs through the admin API and produces an active deployment for a
  tenant that resolves (`pack-e.itest.ts`). This shows the data-driven vertical runtime works.
- Live turn (done): a real inbound turn runs against an electrician tenant on live Temporal and the
  local LLM. The generic host interprets `electrician-intake`, the triage rule routes to the
  dispatcher agent node, and a real bounded agent turn completes (`path=[triage,assist,end]`). Run
  note: the e2e also needs `HERMES_CREDENTIALS_MASTER_KEY` now (ADR-026 envelope store).
- Tool-backed turns (done 2026-07-17, verified live): the dispatcher answers from real data.
  `appointment.slot.read`, the platform's standard scheduling capability, is exposed as a real
  agentback `@tool`. The tool body resolves the ranked `ProviderAdapter`, and
  `InternalSchedulerProvider` (`infrastructure/scheduler`) serves it. A scheduling intent leads the
  LLM to call the tool, which hits the real provider and returns real slots. The call is recorded in
  `runtime.tool_executions` with `metrics.providerId=internal-scheduler`. An emergency intent
  correctly skips the tool and answers on safety. The triage rule reads the real `intent` fact,
  bound from the inbound message `text` and lowercased. Hazard terms are ordered before scheduling
  terms, so a caller who reports both is triaged as an emergency (`pack-e-rule.spec.ts`).
- PE6 (done 2026-07-17): when a capability's `onNoProvider` is `handoff`, the turn now goes to a real
  handoff. The failed dispatch ends the turn in `handoff`, with `error-escalation` in the turn ledger
  that is handed to persistence (`single-step-turn.spec.ts`).
- Reply delivery (done 2026-10-24): the `assist` agent node declares `deliverReply`. When a turn ends
  `replied`, its final, post-gated reply is sent to the caller through the platform's
  `messaging.reply.send` capability (template `electrician_agent_reply`, recipient
  `{"$input": "from"}`). Each reply writes one durable outbound `runtime.messages` row. A handoff
  sends nothing.

## What's still open for this vertical

Tracked in [`../../docs/DEFERRED-AND-FLAGGED.md`](../../docs/DEFERRED-AND-FLAGGED.md) (PE1, PE5):

- The per-vertical doc set isn't written yet (domain model, workflow catalog, and related docs).
- PE5: the scheduler provider is a config-driven placeholder. Slots come from
  `ProviderExecutionContext.config.slotTemplates`, which is now resolved from the tenant's own
  envelope-encrypted credential row (ADR-026, landed 2026-07-17). The e2e shows that a tenant
  `rotate()` changes live slot output with no deploy. A real vendor scheduler plugs in behind the
  same `ProviderAdapter` port. The credential piece it needed is done.
- There's no `VerticalPackController` REST install. The pack installs with `installVerticalPack` or
  the admin API.

## Installing another vertical

None of this is electrician-specific code. `installVerticalPack(pgUrl, redisUrl, tenantId, packPath)`
(`apps/workflow-worker/src/pack-e-install.ts`) works on any pack. It authors each definition through
`DefinitionRegistry.put` and publishes through `DeploymentService`, which is exactly what the admin
API's `PUT /v1/definitions` and `POST /v1/deployments` do. A new vertical is a new `pack.json`. It
needs no new code.
