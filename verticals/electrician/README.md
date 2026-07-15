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
| capability | `electrical.slot.read` | Read open service-visit slots (provider-neutral). |
| agent-engine | `electrician-dispatcher` | Safety-first dispatcher persona; may use `electrical.slot.read`. |

## Status

- **Slice 1 (done):** the pack installs through the admin API and produces a resolvable **active
  deployment** for a tenant (`pack-e.itest.ts`) — proving the data-driven vertical runtime.
- **Next:** drive a real inbound turn against an electrician tenant (manual local-LLM gate); enrich the
  triage rule with real intent conditions; author the full per-vertical doc set
  (`domain-model.md`, `workflow-catalog.md`, … per `verticals/000-future-verticals-workplan.md`).
