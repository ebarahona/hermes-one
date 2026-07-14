# Architecture Decision Records — hermes-one

Durable, in-repo log of the **ratified** architecture decisions the code is
governed by. Code comments cite these by number (e.g. `(ADR-017)`); this file is
what those citations resolve to, and it ships with the repo.

Each entry is a one-paragraph distillation. The canonical, full-length decision
records live in the architecture set (`01-foundation/006-architecture-decisions.md`);
this log is the self-contained handoff copy — no reference here depends on a
document that might not travel with the code.

> Status: all decisions below are **ratified**. Earlier ADR-001…012 concern the
> pre-implementation architecture phase and are summarized in the canonical log.

---

- **ADR-013 — Verticals are data, not code.** Industry packs (workflows, rules,
  policies, prompts, templates, knowledge, evals) are authored, versioned, signed
  data bundles that reference platform capabilities by name. Code is added only
  for a genuinely new platform capability.

- **ADR-014 — One workflow interpreter; workflows are compiled data.** A single
  Temporal workflow (`executeCompiledWorkflow`) walks a compiled, content-hashed
  plan. Never a Temporal file per business process.

- **ADR-015 — Rulesets are first-class, bounded, data-driven decisions.** Rules
  _decide_ (pure over provided facts: no I/O, no waits, no side effects);
  workflows _orchestrate_. A rule returns an outcome the workflow routes on.

- **ADR-016 — The platform is a configuration-driven definition substrate.** Five
  definition types in two families — three logic DSLs (workflow, rule, policy)
  sharing one expression core + compiler pipeline, and two contract schemas
  (capability, agent-engine) that are validated config with no compiler. One
  substrate lifecycle: author → validate → compile/validate → content-hash →
  store → pin → interpret.

- **ADR-017 — AgentBack is the agent-plane substrate; planes meet only at
  serializable boundaries.** The edge/data plane (`@loopback/*`) and the agent
  plane (`@agentback/*`) never share a live `Context`. They meet only across
  Temporal activity I/O, PostgreSQL, and HTTP. The bridge between them is a thin
  value-mapper (identity in → agentback principal out), not a DI marshaller.

- **ADR-018 — The agent executor wraps agentback dispatch; the ToolResult is
  synthesized around it.** The platform executor calls agentback's tool dispatch
  and builds the rich `ToolResult` envelope around the unwrapped, output-validated
  result — `sideEffect`/`changedDomains`/`stateChanged` from capability metadata,
  `evidence`/`metrics` from a dispatch hook. Tools stay plain agentback `@tool`s;
  no second dispatch pipeline.

- **ADR-019 — One authorization pipeline.** The Policy DSL compiles to agentback
  voters plus pre/post gates; order is pre-gate → voters → post-gate. Policy
  answers "may I?" and can block; rules answer "which way?" and route.

- **ADR-020 — Contracts are Zod-first.** Zod is the single source of truth;
  JSON Schema / OpenAPI are generated from it. No separate contract package.

- **ADR-021 — The agent runtime drives single-step model calls.** The platform
  owns a bounded loop (propose → gate → execute → refresh → compose → post-gate),
  making one single-step model call per step — not an autonomous tool loop. This
  keeps `confirm:` side-effecting tools reachable and preserves the decide/compose
  split.

- **ADR-022 — ESM and Node ≥22.13; Drizzle over juggler.** The whole workspace is
  ESM on Node ≥22.13. Persistence is Drizzle (drizzle-zod + drizzle-kit) behind
  injected repository ports (Data Mapper), never juggler. DI/IoC is unaffected.

- **ADR-023 — Rule nodes evaluate in a Temporal activity.** A workflow `rule`
  node evaluates in an `evaluateRule` activity; `RuleRuntime` is also directly
  callable inside the agent turn / eligibility checks (already in activities).

- **ADR-024 — Composable, independently-scalable core.** Three governing laws: a
  composable core (services depend on interfaces, not implementations); services
  own their data; independent scaling per traffic tier.
