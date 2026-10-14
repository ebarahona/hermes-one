# Architecture Decision Records — hermes-one

The project's decision record: the **ratified** architecture decisions the code is
governed by. Code comments cite these by number (e.g. `(ADR-017)`); this file is
what those citations resolve to.

Each entry is a one-paragraph distillation.

> Status: all decisions below are **ratified**. ADR-001…012 cover the earlier
> pre-implementation architecture phase and are not reproduced here.

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

- **ADR-025 — One SecretProvider; references never name vendors.** The
  secrets-and-key-management port is canonical: `SecretRef` is
  `secret://<store>/<path>` where the first segment is a logical STORE, never a
  backend vendor; `resolve()` returns `ResolvedSecret`; caching is TTL-bounded
  with `invalidate()` (rotation is a cache-drop, never a process restart).
  The earlier secrets-registry design is SUPERSEDED for the port/grammar (its
  ops/runbook content stands). `SecretManagerConfig.backend` stays unpinned
  config chosen at the composition root — embedding a vendor in every stored
  reference would make swapping backends a platform-wide rewrite and forecloses
  per-residency backends. Resolves ledger S5.

- **ADR-026 — Tenant provider credentials are envelope-encrypted rows, not
  secret-manager entries.** The platform has two trust chains (ADR-025's doc):
  operational secrets by ref, and per-tenant keys enveloped under a tenant CMK.
  Tenant vendor credentials (Twilio SIDs etc.) belong to the SECOND chain: a
  cloud secret manager priced/quota'd per secret is O(tenants × providers) —
  ~30k managed secrets at 10k tenants, on the dispatch hot path — while
  envelope-encrypted rows in `capability.provider_credentials` (RLS'd like all
  tenant data) cost storage, cache the KMS unwrap, and rotate as a row update.
  PLATFORM secrets (datastore URLs, signing keys — O(1) in tenants) stay on the
  SecretProvider chain. `ProviderCredentialStore.resolve(tenantId, providerId,
  capability)` returns the credential RECORD (decrypt happens behind the port;
  only one component touches key material); the orphaned `configKey` is DELETED
  from contracts — the tuple is the identifier. Resolves ledger S6; amends
  the table catalog (new table) and the secrets-and-key-management design (chain
  ownership).

- **ADR-027 — The role matrix governs role scopes; seeded defaults never carry
  wildcards.** The security pack owns the role model; the
  migrations-and-seed design's divergent `customer` seed (`appointment.booking.*`) is corrected to the
  role-matrix scopes. A wildcard in a SEEDED DEFAULT role silently auto-grants
  every future capability in that namespace (a new `appointment.booking.refund`
  would flow to every customer) — least-privilege requires enumerated leaf
  scopes in defaults; wildcards remain legal in tenant-authored roles. Migration
  0029 already complies. Resolves ledger PE4.

- **ADR-028 — Tool-output evidence is authoritative and trusted; `trusted:false`
  is the retrieved-content injection defense.** `EvidenceRecord.trusted` exists
  for indirect-prompt-injection handling (its own contract comment): a
  schema-validated result from a capability the platform authored, gated, and
  invoked is NOT an injection vector, and ADR-009 evidence-only composition
  grounds ONLY on trusted evidence — stamping tool output untrusted would remove
  the facts the agent just fetched from grounding and skip the post-gate.
  `tool-output` evidence is `source:'authoritative', trusted:true` on every
  path; `CapabilityInvoker` (which stamped provider/false) aligns. Retrieved/
  free-text content stays untrusted. If a vendor field ever flows into a prompt,
  split trust by FIELD, not by flipping the envelope. Resolves ledger A6.

- **ADR-029 — Worker versioning pins the Worker-Deployments generation; the
  replay gate is generation-independent and lands first.** the
  worker-versioning-and-replay design mandates Build-ID versioning + `patched()`
  for risky interpreter changes + a hard replay-test gate, but leaves the
  Temporal API generation UNPINNED (an open question in that design). Our installed SDK
  (@temporalio 1.20.2) deprecates the legacy `buildId`/`useVersioning` shape;
  the successor is `workerDeploymentOptions` ({version: {buildId,
  deploymentName}, useWorkerVersioning, defaultVersioningBehavior}) — and
  `PINNED` behavior is exactly the design's requirement (open executions stay on
  the build they started on). Building new infrastructure on a deprecated API
  contradicts this platform's charter, so: (1) the generation is PINNED to
  Worker Deployments; the design's `BuildIdRegistry` compatible-with model maps
  onto deployment versions; (2) `executeCompiledWorkflow` runs PINNED —
  interpreter code (`buildId`) and plan data (`contentHash`) stay orthogonal
  axes (ADR-014); (3) the REPLAY GATE — replay captured histories against the
  candidate interpreter, fail CI on ANY nondeterminism, no waiver path — is
  generation-independent (`Worker.runReplayHistories`) and ships immediately;
  versioned dispatch itself is config-gated off in dev until the compose
  server's support is verified live (never enable an unverified primitive).
  Resolves ledger T6's design half.
