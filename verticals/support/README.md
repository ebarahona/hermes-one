# Support-ticket triage vertical

A second vertical, authored entirely as **data** (ADR-013 — "verticals are data, not code"), for
inbound customer support on a software product. It installs exactly as the electrician vertical does
— `installVerticalPack(pgUrl, redisUrl, tenantId, 'verticals/support/pack.json')`, or the admin API's
`PUT /v1/definitions/{id}` + `POST /v1/deployments` — and runs on the same workflow interpreter, rule
runtime, and policy runtime. No support-specific code exists in the platform.

The pack demonstrates the platform's core routing model: **most messages are handled by
deterministic rules, and the model is called only for a message that needs judgment.**

## The bundle (`pack.json`)

| Family       | Name                   | What it does                                                                               |
| ------------ | ---------------------- | ------------------------------------------------------------------------------------------ |
| workflow     | `support-intake`       | Triage an inbound message, then reply by template, escalate, or hand to the support agent. |
| rule         | `support-triage`       | Classifies the message `text` into a routing outcome (case-insensitive keyword match).     |
| policy       | `support-reply-safety` | Post-gate on the agent's draft reply: a reply that asks for a password is repaired.        |
| capability   | `messaging.reply.send` | Send a reply to the customer on their channel: templated replies and the agent's reply.    |
| agent-engine | `support-assistant`    | Courteous, concise support persona; no tools; runs on the deployment's configured model.   |

## Workflow graph

```mermaid
flowchart LR
  triage{{"triage<br/>(rule: support-triage)"}}
  triage -- escalate --> escalation_notice["escalation_notice<br/>(messaging.reply.send)"]
  escalation_notice --> escalate(["escalate<br/>terminal: handoff"])
  triage -- password-reset --> password_reset["password_reset<br/>(messaging.reply.send)"]
  triage -- billing --> billing["billing<br/>(messaging.reply.send)"]
  triage -- account-faq --> account_faq["account_faq<br/>(messaging.reply.send)"]
  triage -- default --> assist["assist<br/>(agent: support-assistant,<br/>reply via messaging.reply.send)"]
  password_reset --> end_(["end<br/>terminal: completed"])
  billing --> end_
  account_faq --> end_
  assist --> end_
```

The rule node reads one fact, `text`, bound from the channel-neutral run input (`{"$input": "text"}`).

## Triage outcomes

Branches are evaluated in order and the first match wins. Every term is matched with
`contains(lower(text), term)`, so matching is case-insensitive.

| Order | Outcome          | Terms                                                                                                 | Route                                         |
| ----- | ---------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1     | `escalate`       | `outage`, `is down`, `breach`, `hacked`, `compromised`, `unauthorized`, `security incident`, `urgent` | Templated notice, then the `handoff` terminal |
| 2     | `password-reset` | `password`, `locked out`, `can't log in`, `cannot log in`, `can't sign in`, `cannot sign in`          | Templated reply                               |
| 3     | `billing`        | `invoice`, `receipt`, `billing`, `payment method`                                                     | Templated reply                               |
| 4     | `account-faq`    | `change my email`, `update my email`, `update my profile`, `two-factor`, `2fa`, `export my data`      | Templated reply                               |
| —     | `needs-judgment` | (default — no term matched, including a message with no text)                                         | Bounded agent turn                            |

Escalation is ordered first so that a message reporting both an outage or security issue and a simple
intent ("someone hacked my account and changed my password") is escalated rather than answered by a
template.

## How escalation is realized

Escalation is **deterministic**: the `escalate` outcome routes to a capability node that sends a
templated notice to the customer, then to a terminal node with `outcome: "handoff"` and
`result: {"queue": "urgent", "reason": "outage-or-security-report"}`. The workflow run ends with the
`handoff` outcome without calling the model. Every rule decision, escalations included, is recorded
as a `decision.rule` audit event.

The agent engine is configured with no tools (`allowedCapabilities: []`): it answers in its composed
reply, which passes through the `support-reply-safety` post-gate.

## How the agent's reply is delivered

The `assist` node declares `deliverReply`: when the turn ends with the `replied` outcome, the
workflow sends the turn's final, post-gated reply through `messaging.reply.send` (template
`support_agent_reply`, body bound with `{"$agent": "reply"}`, recipient bound with
`{"$input": "from"}`) — the same capability path the templated replies use. A reply the post-gate
repaired is delivered in its repaired form. A turn that hands off sends nothing.

## Verification

- `apps/workflow-worker/src/support-pack-rule.spec.ts` — unit: the triage rule routes each intent
  class as designed (mixed case included), escalation outranks a simple intent, and the compiled
  workflow walks each route with the expected path and no agent turn on the deterministic routes;
  the agent route delivers the turn's reply and a handoff delivers nothing.
- `apps/admin-api/src/support-pack.itest.ts` — integration: installs the pack through the admin API
  and asserts the active deployment reconstructs with the support pack's members.
- `apps/agent-worker/src/support-pack.e2e.ts` — manual gate (needs a model endpoint): one live run
  per routing class on real Temporal, asserted against the durable audit timeline and one outbound
  `runtime.messages` row per run.

## What is still open for this vertical

Tracked in [`../../docs/DEFERRED-AND-FLAGGED.md`](../../docs/DEFERRED-AND-FLAGGED.md) (SP1–SP3):

- **SP1** — a workflow `handoff` terminal ends the run with the `handoff` outcome but does not write a
  `runtime.handoff_tasks` row; only an agent turn's handoff outcome persists one today.
- **SP2** — reply bodies are authored inline on the capability nodes; the `template` field is an
  identifier only, with no tenant template catalog resolving it (CT6). No ticket-system capability
  exists, so the pack does not open or update tickets.
- **SP3** — the support agent cannot itself request a human; escalation is decided by the triage
  rule before the agent node.
