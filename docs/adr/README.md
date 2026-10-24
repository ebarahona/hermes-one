# Architecture Decision Records: hermes-one

These are the accepted architecture decisions the code follows. Code comments cite
them by number (e.g. `(ADR-017)`), and this file is where those citations point.

Each entry is a one-paragraph summary.

> Status: all decisions below are **accepted**. ADR-001…012 are the foundation
> decisions the later ones build on. ADR-013 onward record decisions made during
> implementation.

---

- **ADR-001: LoopBack 4 is the application composition framework.** DI, IoC,
  contexts, components, extension points, controllers, repositories, and
  application lifecycle come from LoopBack 4. That gives modular, discoverable
  capabilities and tenant-aware dependency resolution. Packages follow its binding
  and metadata conventions.

- **ADR-002: AgentBack is the agent-facing contract layer.** AgentBack exposes
  approved capabilities through MCP, REST, OpenAPI, typed contracts, and
  machine-readable errors. Agent-facing interfaces need stricter contracts than
  generic service APIs. AgentBack complements LoopBack 4 and does not replace the
  service architecture.

- **ADR-003: Temporal is the initial durable workflow runtime.** Retries,
  timers, signals, durable waits, workflow history, and long-running execution
  (seconds to months) belong to Temporal. Workflow code stays deterministic.
  Network and database work lives in activities.

- **ADR-004: The platform owns a workflow DSL.** The DSL is independent of
  Temporal SDK types, so the workflow definition stays a portable,
  tenant-configurable product asset. This requires a compiler and a compatibility
  layer.

- **ADR-005: PostgreSQL is the authoritative platform storage.** Tenants, workflow
  definitions, deployments, conversations, audit records, and configuration live in
  PostgreSQL for transactional consistency and relational integrity. That makes
  schema design and tenant isolation critical.

- **ADR-006: Redis holds only derived or ephemeral state.** Caches, idempotency,
  locks, quotas, rate limits, queues, pub/sub, and ephemeral coordination use
  Redis. It is never the only source of critical truth. Queues and pub/sub serve
  non-durable coordination and real-time fan-out only. Work that must survive
  restarts belongs in Temporal. Cache rebuild and fallback behavior must be
  defined.

- **ADR-007: Retrieve relevant slices instead of replaying whole conversations.**
  Only relevant knowledge and memory slices are retrieved, because full transcript
  replay raises cost and noise. Summarization, embeddings, and retrieval quality
  are first-class concerns. (Knowledge and memory retrieval is not yet implemented.
  See README Roadmap.)

- **ADR-008: Graph storage is optional.** The MVP needs no graph database.
  PostgreSQL, Redis, and vector retrieval (not yet implemented, see README
  Roadmap) serve the early use cases. Graph interfaces stay abstracted so one can
  be added later.

- **ADR-009: Decision is separated from composition.** The model proposes tool
  calls in one phase. It writes customer-facing language only after execution is
  confirmed, so the agent cannot claim actions that did not happen. The runtime
  collects explicit evidence to compose from.

- **ADR-010: Capabilities are provider-neutral.** Workflows reference stable
  capability names so vendors can be replaced without changing workflow semantics.
  Provider resolution and contract compatibility are platform responsibilities.

- **ADR-011: Vertical packs are installable units.** Industry behavior (tools,
  workflows, policies, schemas, evaluations) ships as an installable pack, so the
  product can expand across industries. Manifests, compatibility rules, signing,
  and upgrade behavior follow from that. Refined by ADR-013: a pack is a data
  bundle that the platform runtime interprets. A pack contributes a LoopBack
  component only to register a new platform-level provider-neutral capability or
  adapter, and never to carry industry content.

- **ADR-012: Human handoff is an explicit workflow outcome.** Handoff, pause,
  resume, and takeover are durable workflow states, because human intervention is
  expected and must be auditable. The admin console and workflow runtime are to
  support the ownership transitions. (Partly implemented: `handoff` is a terminal
  workflow outcome, and an agent-turn handoff persists a durable
  `runtime.handoff_tasks` row. The pause/resume/takeover states, the wait/signal
  nodes they need, the admin console, and the ownership transitions are not yet
  built. See README Roadmap.)

- **ADR-013: Verticals are data, not code.** Industry packs (workflows, rules,
  policies, prompts, templates, knowledge, evals) are authored, versioned, signed
  data bundles that reference platform capabilities by name. Code is added only
  for a genuinely new platform capability. (Definitions are content-hashed today.
  Pack signing is not yet implemented.)

- **ADR-014: One workflow interpreter; workflows are compiled data.** A single
  Temporal workflow (`executeCompiledWorkflow`) walks a compiled, content-hashed
  plan. There is never a Temporal file per business process. As built, the
  interpreter is `executeCompiledWorkflow` in
  `packages/workflow-dsl/src/interpreter.ts`. The registered Temporal workflow
  types (`runCompiledWorkflow`, `runAgentWorkflow` in
  `apps/workflow-worker/src/workflows.ts`) are thin hosts that call it.

- **ADR-015: Rulesets are first-class, bounded, data-driven decisions.** Rules
  _decide_ (pure over provided facts: no I/O, no waits, no side effects).
  Workflows _orchestrate_. A rule returns an outcome the workflow routes on.

- **ADR-016: The platform is driven by configured definitions.** There are five
  definition types in two families. Three are logic DSLs (workflow, rule, policy)
  that share one expression core and compiler pipeline. Two are contract schemas
  (capability, agent-engine): validated config with no compiler. All five share
  one lifecycle: author → validate → compile/validate → content-hash → store →
  pin → interpret.

- **ADR-017: AgentBack is the agent-plane foundation; planes meet only at
  serializable boundaries.** The edge/data plane (`@loopback/*`) and the agent
  plane (`@agentback/*`) never share a live `Context`. They meet only across
  Temporal activity I/O, PostgreSQL, and HTTP. The bridge between them is a thin
  value mapping, with no DI marshaller. As built there is no separate bridge
  package. The principal crosses as plain data in the `TurnRequest` workspace,
  and the agent activity (`apps/agent-worker/src/agent-activity.ts`) reads its id
  and scopes to narrow the turn's tool set and feed the policy gates.

- **ADR-018: The agent executor wraps agentback dispatch, and the ToolResult is
  built around it.** The platform executor calls agentback's tool dispatch. It
  builds the rich `ToolResult` envelope around the unwrapped, output-validated
  result: `sideEffect`/`changedDomains`/`stateChanged` come from capability
  metadata, and `evidence`/`metrics` come from a dispatch hook. Tools stay plain
  agentback `@tool`s. There is no second dispatch pipeline.

- **ADR-019: One authorization pipeline.** The Policy DSL compiles to agentback
  voters plus pre/post gates. The order is pre-gate → voters → post-gate. Policy
  answers "may I?" and can block. Rules answer "which way?" and route. As built,
  the pre- and post-gates run in `components/agent-runtime/src/turn.ts`. Compiled
  voters are carried in the plan but not yet registered with agentback, so the
  voter stage is not enforced.

- **ADR-020: Contracts are Zod-first.** Zod is the single source of truth, and
  JSON Schema / OpenAPI are generated from it. There is no separate contract
  package. (The generator is not yet implemented. Capability contracts carry
  hand-authored JSON Schema, which the agent plane rebuilds into Zod, and admin-API
  request bodies are Zod-validated in the controllers.)

- **ADR-021: The agent runtime drives single-step model calls.** The platform
  owns a bounded loop (propose → gate → execute → refresh → compose → post-gate)
  and makes one single-step model call per step. It does not run an autonomous
  tool loop. This keeps `confirm:` side-effecting tools reachable and preserves
  the decide/compose split. (The refresh step is a documented no-op in this build:
  no read-back capability is wired.)

- **ADR-022: ESM and Node ≥22.13; Drizzle over juggler.** The whole workspace is
  ESM on Node ≥22.13. Persistence is Drizzle (drizzle-zod + drizzle-kit) behind
  injected repository ports (Data Mapper), never juggler. DI/IoC is unaffected.

- **ADR-023: Rule nodes evaluate in a Temporal activity.** A workflow `rule`
  node evaluates in an `evaluateRule` activity. `RuleRuntime` can also be called
  directly inside the agent turn and eligibility checks (which already run in
  activities).

- **ADR-024: Composable, independently scalable core.** Three governing laws: a
  composable core (services depend on interfaces, not implementations), services
  own their data, and each traffic tier scales independently.

- **ADR-025: One SecretProvider; references never name vendors.** This is the
  one secret port. `SecretRef` is `secret://<store>/<path>`, where the first
  segment is a logical store and never a backend vendor. `resolve()` returns
  `ResolvedSecret`. Caching is TTL-bounded with `invalidate()`, so rotation is a
  cache drop and never a process restart. As built, the only adapter is the
  dev-only `EnvSecretProvider` (`infrastructure/config`), which has no cache, and
  no `SecretManagerConfig` exists yet. This supersedes an earlier registry-style
  design for the port and grammar. `SecretManagerConfig.backend` stays unpinned
  config chosen at the composition root. Embedding a vendor in every stored
  reference would make swapping backends a platform-wide rewrite and would rule
  out per-residency backends. Resolves ledger S5.

- **ADR-026: Tenant provider credentials are envelope-encrypted rows, not
  secret-manager entries.** The platform has two trust chains (ADR-025):
  operational secrets by ref, and per-tenant keys enveloped under a tenant CMK.
  Tenant vendor credentials (Twilio SIDs etc.) belong to the second chain. A
  cloud secret manager priced and quota'd per secret is O(tenants × providers):
  about 30k managed secrets at 10k tenants, on the dispatch hot path.
  Envelope-encrypted rows in `capability.provider_credentials` (RLS'd like all
  tenant data) cost storage, cache the KMS unwrap, and rotate as a row
  update. Platform secrets (datastore URLs, signing keys, which are O(1) in
  tenants) stay on the SecretProvider chain.
  `ProviderCredentialStore.resolve(tenantId, providerId, capability)` returns the
  credential record. Decryption happens behind the port, so only one component
  touches key material. The orphaned `configKey` plays no part in credential
  lookup: the tuple is the identifier. (An unread optional `ProviderRef.configKey`
  field still remains in the contracts.) Resolves ledger S6. Adds the
  `capability.provider_credentials` table and assigns tenant vendor credentials
  to the second chain and platform secrets to the first.

- **ADR-027: The role matrix governs role scopes; seeded defaults never carry
  wildcards.** The security pack owns the role model. An earlier divergent
  `customer` seed (`appointment.booking.*`) is corrected to the role-matrix
  scopes. A wildcard in a seeded default role silently grants every future
  capability in that namespace (a new `appointment.booking.refund` would flow to
  every customer). Least privilege requires enumerated leaf scopes in defaults.
  Wildcards stay legal in tenant-authored roles. Migration 0029 already complies.
  Resolves ledger PE4.

- **ADR-028: Tool-output evidence is authoritative and trusted; `trusted:false`
  is the defense against injection through retrieved content.**
  `EvidenceRecord.trusted` exists for indirect prompt injection handling (per its
  own contract comment). A schema-validated result from a capability the platform
  authored, gated, and invoked is not an injection vector. ADR-009 evidence-only
  composition grounds only on trusted evidence, so stamping tool output untrusted
  would drop the facts the agent just fetched from grounding and skip the
  post-gate. `tool-output` evidence is `source:'authoritative', trusted:true` on
  every path, and `CapabilityInvoker` (which stamped provider/false) now matches.
  Retrieved and free-text content stays untrusted. If a vendor field ever flows
  into a prompt, split trust per field instead of flipping the envelope. Resolves
  ledger A6.

- **ADR-029: Worker versioning pins the Worker Deployments generation; the
  replay gate does not depend on the generation and lands first.** The platform's
  versioning rules require Build-ID versioning, `patched()` for risky interpreter
  changes, and a hard replay-test gate. They left the Temporal API generation
  unpinned (an open question). Our installed SDK (@temporalio 1.20.2) deprecates
  the legacy `buildId`/`useVersioning` shape. The successor is
  `workerDeploymentOptions` ({version: {buildId, deploymentName},
  useWorkerVersioning, defaultVersioningBehavior}), and `PINNED` behavior is
  exactly what we need (open executions stay on the build they started on).
  Building new infrastructure on a deprecated API goes against this platform's
  charter. So: (1) the generation is pinned to Worker Deployments, and the
  `BuildIdRegistry` compatible-with model maps onto deployment versions; (2)
  `executeCompiledWorkflow` runs `PINNED`, and interpreter code (`buildId`) and
  plan data (`contentHash`) stay independent axes (ADR-014); (3) the replay gate
  replays captured histories against the candidate interpreter and fails CI on
  any nondeterminism, with no waiver path. It does not depend on the generation
  (`Worker.runReplayHistories`) and ships immediately. Versioned dispatch itself
  is config-gated off in dev until the compose server's support is verified live
  (never enable an unverified primitive). Resolves the design half of ledger T6.
  As built, the replay gate runs in CI. The versioning options type
  (`WorkflowWorkerVersioning`, `infrastructure/temporal-client/src/versioning.ts`)
  is declared but not yet wired into the worker, so versioned dispatch is not
  implemented.

- **ADR-030: `ChangedDomain` is an open, pack-declared identifier.** Refines
  ADR-018. A capability's `changedDomains` names the business-state domains it
  changes. The value drives selective refresh and the `ToolResult` envelope. The
  core keeps the domains it names (`appointment`, `contact`, `conversation`,
  `payment`, `knowledge`, `messaging`, `none`) as the documented constant
  `KNOWN_CHANGED_DOMAINS`. `ChangedDomain` accepts any lowercase identifier
  (`^[a-z][a-z0-9_-]*$`), so a vertical pack can declare its own domains without
  editing a core contract (ADR-013). `none` keeps its meaning (no business state
  changed) and is the only value selective refresh skips. Every other domain,
  known or pack-declared, is passed through and marks that domain dirty.
