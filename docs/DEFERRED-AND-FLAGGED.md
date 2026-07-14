# Deferred & Flagged Items — living ledger

The single running registry of every **intentional deferral, JIT stand-in, and spec gap** in the
`hermes-one` build. When we build to spec and hit something we deliberately did not finish (a real
library differs, a spec doc doesn't exist yet, a demo shortcut unblocks a slice), we record it here
instead of silently improvising — per the spec-fidelity mandate.

**How to use this doc**
- Every flagged/JIT/stand-in item in the code (search markers: `flagged`, `JIT`, `follow-up`,
  `stand-in`, `demo`, `not implemented`, `Open Questions`) has a row here.
- Each row: **what** is deferred · **why** (spec ref / reason) · **where** it's stubbed · **faithful
  target** (what "done" is) · **status**.
- When you resolve an item, flip status to ✅ and add the commit/date. Do **not** delete resolved rows
  for one release cycle — they document how the shortcut was unwound.
- New deferrals get appended under the right area. Keep `PROJECT-CONTEXT.md` → "▶ Resume here" as the
  narrative; this doc is the exhaustive checklist it points to.

Severity: 🔴 correctness/security risk if it ships as-is · 🟡 real but scoped follow-up · ⚪ cosmetic.

---

## Security / secrets

| # | Item | Sev | Why deferred | Where stubbed | Faithful target |
|---|------|-----|--------------|---------------|-----------------|
| S1 | **Per-tenant KMS credential store** | 🔴 | No cloud secret manager wired in this build | `components/channels/src/credential-store.ts` (`StaticProviderCredentialStore`, env-backed, **tenant-agnostic** — one bundle per provider); creds enter via `infrastructure/config` from env | `security/secrets-and-key-management.md` — KMS-backed `ProviderCredentialStore` scoped to `(tenantId, providerId, capability)`, rotation, audit; DEK/`RetentionKeyStore` |
| S2 | **Secrets in central config** | 🟡 | Expedient for local/dev | `infrastructure/config/src/config.ts` — `llm.apiKey`, `sms.*` creds read from env into `HermesConfig` | Resolve through the `SecretRef` grammar + `SecretProvider` port (`secrets-and-key-management.md`), never materialized in the config object |

## Capability / provider plane

| # | Item | Sev | Why deferred | Where stubbed | Faithful target |
|---|------|-----|--------------|---------------|-----------------|
| P1 | **No `providers/` / `capabilities/` runtime spec pack** | 🟡 | That doc pack was never generated | `packages/capability-contract/*`, `components/channels/src/messaging.ts` — resolver/invoker/messaging contract authored **JIT** to `contracts/{capability,provider}-contracts.md` | Generate the runtime providers/capabilities pack, then reconcile the JIT contracts against it |
| P2 | **In-process circuit breaker** | 🟡 | Single-worker build | `components/channels/src/vendor-sms-provider.ts` — breaker state lives in the provider instance | Shared breaker (Redis) so multi-instance workers agree — `redis/idempotency-locks-ratelimits.md` |
| P3 | **SMS receipts + opt-out (STOP/HELP)** | 🟡 | Not on the inbound/outbound happy path | `components/channels/src/sms-transport.ts` — `parseReceipt` returns null, `isOptedOut` returns false | Async delivery-receipt webhook → `DeliveryReceipt` signal; opt-out ledger checked before send (`provider-contracts.md`) |
| P4 | **Live vendor account** | 🟡 | No real Twilio account in this env | `components/channels/src/vendor-sms.itest.ts` drives a **local fake-Twilio** HTTP server (the adapter code exercised is the real prod path) | Point `SMS_BASE_URL` at real Twilio; add a smoke test behind a creds-gated CI job |
| P5 | **Outbound rows under the `(tenant_id, provider_message_id)` partial-unique index** | ⚪ | Index was built for inbound idempotency; outbound now also carries `provider_message_id` | `infrastructure/drizzle` schema + `VendorSmsProvider.execute` persist | Benign in prod (vendor SIDs are unique). Revisit only if a vendor reuses SIDs |

## Agent runtime / model

| # | Item | Sev | Why deferred | Where stubbed | Faithful target |
|---|------|-----|--------------|---------------|-----------------|
| A1 | **JIT `SingleStepModel` port** | 🟡 | No canonical model-port spec doc exists | `infrastructure/model-client/src/port.ts` — port authored JIT to ADR-021 | Reconcile against a real model-port spec when generated (or ratify this as the ADR) |
| A2 | **`repair` post-gate re-compose not done** | 🟡 | Bounded re-compose out of scope | `components/agent-runtime/src/turn.ts` — on `repair` the grounded draft is delivered as-is (the decision IS now persisted to `policy_decisions`, so the boundary is auditable) | Re-compose the reply under the repair instruction, then re-gate |
| A3 | **`policy-dsl` package name differs from spec** | ⚪ | Repo mirrors `rule-dsl` layout | `@platform/policy-dsl` vs spec's `policy-compiler`/`policy-runtime` | Cosmetic; algorithm is faithful. Rename or note in ADR |
| A4 | **Handoff *lifecycle* not built** (initial request now persists) | 🟡 | The full state machine (assign/takeover/resolve via Temporal signals + admin inbox) is scoped to the `admin`/`temporal` packs by the contract itself | Turn hands off → `DrizzleHandoffRepository.requestHandoff` writes the initial `runtime.handoff_tasks` row (status `requested`, owner `agent`); no signals/assignment/resolution yet. Routing defaults (`queue:'general'`, `priority:'normal'`, no expiry) are hardcoded — no `HandoffConfig`/tenant-config store. A `null` conversationId turn skips the row (handoff_tasks.conversation_id NOT NULL) | Build `HandoffService` (assign/takeover/resolve) on Temporal signals + the admin inbox; wire `HandoffConfig` routing; resolve conversationId before handoff |
| A5 | **JIT turn-ledger seam; persist once at finish** | 🟡 | No canonical turn-ledger persistence-port spec doc | `components/agent-runtime/src/turn.ts` `onPersist` callback + `DrizzleTurnLedgerRepository`; one write at the terminal path (not streamed per tool call as the catalog sequence shows) | Reconcile the seam against a real port spec if generated; consider per-step streaming writes for very long turns |

## Deployment / substrate lifecycle

| # | Item | Sev | Why deferred | Where stubbed | Faithful target |
|---|------|-----|--------------|---------------|-----------------|
| D1 | **resolve-by-pinned-deployment (replay determinism)** | ✅ 2026-07-13 | RESOLVED (triage F5): `CompiledPlanStore.resolveDeployment`/`resolveDeploymentByVersion` (tenant-scoped RLS, superseded rows resolve fine) + `DeploymentService.resolveVersion`; the edge (ingestor + e2e publish) resolves-active-and-**pins** the real `DeploymentRef` into `WorkflowRunRef` → `WorkspaceContext` (`dpl_demo` is gone); `agent-activity` resolves the PINNED deployment fail-closed (no active fallback); `runTriage` rejects an unpinned start | itest: pinned resolve unchanged across supersede + RLS-blocked cross-tenant | — |
| D2 | **`publishBundle` seeds workflow/rule via raw SQL** | 🟡 | Demo publish path | `apps/workflow-worker/src/publish.ts` — owner-connection `INSERT` into `definitions` | Route through `DefinitionRegistry.put` (validate→compile→content-hash→store) like every other definition |
| D3 | **`getDeploymentWithMembers` fail-closes to null without tenant scope** | 🟡 | `deployments` is RLS-protected; no tenant param on that method | `infrastructure/drizzle/src/adapters/compiled-plan-store.repository.ts` | Real load path is `resolveActiveDeploymentCached(tenantId)`; documented in the adapter |
| D4 | **`DefinitionRegistry` id not minted through `platform_app`** | 🟡 | Flagged in Open Questions | `packages/definition-substrate/src/registry.ts` | Confirm id-minting path honors RLS role posture |

## Audit / usage / eventing

| # | Item | Sev | Why deferred | Where stubbed | Faithful target |
|---|------|-----|--------------|---------------|-----------------|
| AU1 | **Usage metered from turn totals, not agentback's stream** | 🟡 | The `UsageMeter` should aggregate agentback's metering stream as the single source of truth (T7); that stream integration isn't wired | DONE: `audit.usage_records` + `DrizzleUsageMeter` (record `INSERT ON CONFLICT(dedupe_key) DO NOTHING` + summarize) + turn `usage` emitted + metered by `agent-worker/usage-events.ts` (model input/output tokens, cost, tool.invocation). But quantities come from the turn's SELF-REPORTED `usage` totals, not agentback's stream | Feed `record()` from agentback's metering stream (correlationId=turnId) instead of the turn totals; add billing-period rollup jobs. message.sent/storage.vector meters (channel/vector layers) still unemitted |
| AU2 | **Audit append is idempotent-skip, not tamper-reject** | ⚪ | Simpler replay-safety | `DrizzleAuditSink.append` uses `ON CONFLICT(id) DO NOTHING` | The port doc says "throws if id/integrityHash already exists" — a DIFFERENT event reusing an id (tamper) should be rejected, not silently skipped. Add an integrity-mismatch check on conflict |
| AU3 | **`message.sent`/`message.received` audit events not emitted** | 🟡 | Those are channel-layer actions, not turn actions | `deriveAuditEvents` (agent-worker) only emits tool.invoked/decision.policy/handoff.requested from the turn ledger | Emit message audit events at the channel transport (inbound ingest / outbound deliver) |
| AU4 | **`deployment.published`/`definition.published`/`tenant.config.changed` audit events not emitted** | 🟡 | Those happen in the substrate/admin layers | Only turn-derived actions are audited today | Emit from `DefinitionRegistry.put` / `DeploymentService.publish` / tenant-config writes |

## Catalog tables built, consumers pending (Tier 2 complete)

The full 21-table catalog + 8 reconciliation views now exist (schema + migration + RLS + constraints,
verbatim from `database/table-catalog.md`). These tables have **no runtime consumer yet** — the schema is
complete; wiring is a per-feature follow-up (mostly Tier 3+: admin console, eventing relay, projections).

| # | Item | Sev | Why deferred | Where | Faithful target |
|---|------|-----|--------------|-------|-----------------|
| CT1 | **`tenant.tenants` uuid vs the text `tnt_…` brand** | 🔴 | `repository-patterns.md` models `tenant.tenants.id/tenant_id` as `uuid`, but every other table + the `app.tenant_id` GUC + the `TenantId` brand use text `tnt_…`. A text-brand session sees ZERO `tenant.tenants` rows (its RLS uses `tenant_id::text = GUC`, fail-closed) | `migrations/0019`/`0020`, `schema/tenant.schema.ts` | Reconcile the tenant identifier type across the system (pick uuid or the text brand) — a cross-doc decision; flagged not improvised |
| CT2 | **`tenant.{workspaces,users,roles,vertical_pack_installations}` have no repos** | 🟡 | Consumers are onboarding + the admin console (not built) | tables + RLS only | `TenantResolver`/onboarding writes + admin CRUD; scope resolution joins `users.role_names` → `roles.scopes` at request time |
| CT3 | **`capability.provider_mappings` not read by the resolver** | 🟡 | The resolver still uses the inline contract mapping | table + RLS only | `ProviderResolver` merges the tenant's DB override ahead of the contract default (absence = use default) |
| CT4 | **`event.event_outbox` WRITER done; publisher/relay pending** | 🟡 | Writer resolved with F3 (2026-07-13): `DrizzleTurnPersistence.persistTurnAtomic` co-commits one outbox row per audit event in the SAME tenant transaction (commit-and-publish, `events/event-envelope.md`); `@platform/contracts/src/event.ts` transcribed (EventEnvelope/EventOutboxRepository/toEventEnvelope); `DrizzleEventOutboxRepository` implements the port | Writer live (agent e2e writes pending rows). The RELAY is not: no poll loop, no Redis pub/sub dispatch; `pollPending(limit)` carries no tenant and fail-closes under strict RLS as platform_app — the cross-tenant publisher needs the privileged-aggregator posture (same open question as the platform-wide analytics rollup). Usage/billing events don't enqueue yet (`events/billing-events.md`) | Publisher loop (poll → `toEventEnvelope` → Redis pub/sub → markPublished/markFailed) + privileged relay role + billing-event fan-out |
| CT5 | **`runtime.workflow_executions_projection` has no writer** | 🟡 | Temporal is the source of truth; the projection is for admin/API querying | table + RLS only | A workflow-status projector (interceptor/worker) upserts execution rows |
| CT6 | **`runtime.message_templates` unused** | 🟡 | Template-based sends not wired | table + RLS only | Channel outbound resolves `templateId` → template body/variables |

## Observability / analytics (Tier 3)

| # | Item | Sev | Why deferred | Where | Faithful target |
|---|------|-----|--------------|-------|-----------------|
| OB1 | **Scalability KPIs: 3 LIVE, 3 still pending** | 🟡 | Partially resolved. **LIVE (Tier 3.2):** `deterministic_hit_rate` (the deterministic rail now emits a `decision.rule` audit event per routing decision; hits = decisions − model turns), `tokens_per_turn`, `cost_per_turn_usd` — computed by `UsageScalabilityAnalyticsService.dashboard`; `ThresholdScalabilityRegressionGate` is built + tested. Live e2e traffic yields det-hit-rate **0.833**. **STILL PENDING (return 0, flagged):** `llm_calls_per_turn` (needs a per-turn model-call meter — no MeterKind for it), `small_model_share` (needs model routing), `worker_occupancy_in_wait` (needs OTel worker metrics) | dashboard/gate in `@platform-internal/analytics`; instrumentation in `activity-worker` (`decision-activities`) + `workflows.ts` | Add the model-call meter + model routing + OTel worker metrics to light up the 3 pending KPIs; do NOT gate on the pending KPIs until then (permissive thresholds). Also: `dashboard(tenantId=null)` platform-wide rollup throws (needs a privileged RLS-bypass aggregator); det-hit-rate assumes one rule decision gates each model turn (multi-turn conversations need per-conversation counting) |
| OB2 | **`CostAnalyticsService.reconcile` has no real agentback export** | 🟡 | agentback's metering stream/export (the T7 source of truth) isn't wired | `UsageCostAnalyticsService` takes an injected `agentbackExport` fn; a stub mirrors platform totals (status 'ok') | Wire agentback's real metering export; schedule periodic reconcile → surface drift (observability/147) |
| OB3 | **Eval framework: runner+gate DONE; workflow-level sim + deployment-load pending** | 🟡 | Partially resolved (Tier 3.4). **DONE:** `contracts/evaluation.ts` (GoldenConversationCase/EvaluationAssertion/EvaluationResult/EvaluationRunner/RegressionGate) + `@platform-internal/evaluation` — `TurnSimulationService` runs the REAL turn loop (`runTurn`, the ONE impl) against injected mocks, dryRun (ledger captured in-memory, NEVER persisted); `DefaultEvaluationRunner` scores all 6 assertion kinds; `DefaultRegressionGate` blocks required-case failures. **PENDING:** (a) the spec's `SimulationService.simulateWorkflow` runs the WHOLE workflow via a Temporal mock-provider worker on a separate task queue — this build is a turn-level in-process cut (shares OB6); (b) the runner takes an injected `simulate(inbound, deploymentRef)` rather than loading the pinned deployment's engine/capabilities/policy itself (the agent-activity does that — wire it as a follow-on); (c) multi-turn conversation state across a case's `turns[]` (each turn simulated independently today); (d) ~~the runner isn't yet consulted by `DeploymentService.publish`~~ **DONE (3.5):** `publish` now calls an injected `regressionCheck(candidate)` after validation, before the atomic commit — `pass:false` ABORTS the publish (nothing written); `@platform-internal/evaluation` provides `runBehavioralRegression` + `combineGateResults` (behavioral + scalability). **What remains:** the COMPOSITION that wires a REAL `regressionCheck` (a `simulate` that loads the candidate deployment's engine/capabilities/policy + a real golden-case suite + a baseline `ScalabilityMetrics`) — today the hook is a seam with fake-fed tests | Compose the real check (deployment-loading simulate + golden cases + baseline KPIs); load-from-deployment; workflow-level Temporal sim (OB6); multi-turn state |
| OB4 | **Zod-v4 deviation: `ReconciliationReport.deltas` keyed by `z.string()` not `MeterKind`** | ⚪ | Zod v4 makes an enum-keyed `z.record` EXHAUSTIVE (all keys required), rejecting the `{}`/partial deltas the report needs | `contracts/analytics.ts` | Cosmetic; keys are still MeterKind values. Revisit if Zod adds partial-enum-record support |
| OB5 | **OTel: logging + metrics DONE; distributed tracing (spans) pending** | 🟡 | Two of three telemetry pillars resolved. **DONE (3.6 logging):** `contracts/telemetry.ts` + `@platform-internal/telemetry` `JsonLogger`/`FieldRedactor`/`RedactingLogger`; a real turn emits a correlation-tagged JSON log, reply PII-redacted. **DONE (3.7 metrics):** `InMemoryMeter` (snapshot) + `LoggingMeter` (metric→structured log) + `DEFAULT_SLO_TARGETS` catalogue; `agent-worker/turn-metrics.emitTurnMetrics` derives TURN_COUNT/latency, per-tool invocation count/latency, per-gate decision count from the turn ledger — a real e2e turn emitted `agent.turn.latency_ms=5510` etc. **PENDING:** (a) OTel spans + the Temporal `WorkflowTraceInterceptor`/`ActivityTraceInterceptor` impls (the span tree edge→workflow→activity→turn→tool — needs the OTel SDK); (b) a real OTel EXPORTER (today the Meter/Logger emit to stdout — prod ships them to a collector); (c) the redaction rule SOURCE (data-retention PiiCipher classification — rules are a hand-passed stand-in). Worker-occupancy KPI (OB1) still needs the spans/collector | Add OTel SDK + span tree + Temporal interceptors + OTel exporter; source redaction rules from the PII classification |
| OB6 | **Replay + simulation (ReplayService/SimulationService) not built** | 🟡 | Needs Temporal history replay (a sandboxed replay worker) + a mock-provider simulation worker on a separate task queue (audit-and-replay.md) | The interfaces are transcribed (`contracts/audit-replay.ts`, `workflowId` typed `string` — no `WorkflowId` brand in substrate yet); only `AuditQueryService` (timeline/query) is implemented | Build `replayWorkflow` (history-only, no activity re-exec) + `simulateWorkflow` (dryRun, mock providers, `detail.dryRun=true`); this also unblocks the eval runner (OB3) |
| OB7 | **Timeline tombstone (crypto-shred) rendering not implemented** | ⚪ | data-retention-jobs.md crypto-shred isn't built, so no shredded rows exist | `DrizzleAuditQueryService` composes only live rows; the `tombstone` entry kind + `tombstoneReason` are in the contract but unused | When retention/crypto-shred lands, render a tombstone placeholder for a shredded `detail` instead of omitting the row |

## Database / infra

| # | Item | Sev | Why deferred | Where stubbed | Faithful target |
|---|------|-----|--------------|---------------|-----------------|
| I0 | **No CI (triage F7) — git repo now EXISTS but every gate is still manual** | 🔴 | Repo created 2026-07-13: private `github.com/ebarahona/hermes-one`, `main`, `.env*` gitignored (part of F10) | no `.github/workflows` | Minimal CI: `pnpm verify` + dockerized `pnpm test:itest` + the 3 e2e scripts on every push ("the cheapest single risk-reduction action" — triage §5) |
| I1 | **drizzle-kit generate + drift-check CI gate** | 🟡 | Hand-authored numbered migrations this phase | `infrastructure/drizzle/migrations/000*.sql` | `drizzle-kit generate` from schema + a CI drift check |
| I2 | **pgbouncer not wired** | 🟡 | Direct pool for now (`SET LOCAL` is pooling-safe) | `infrastructure/drizzle` pool setup | Add pgbouncer transaction pooling in front of the app pool |
| I3 | **dev `platform_app` has no LOGIN/PASSWORD** | ⚪ | Local convenience | pool adopts role via `options=-c role=…` startup param; prod logs in as `platform_app` directly | Prod path already correct; dev note only |

## Temporal / retry policies

| # | Item | Sev | Why deferred | Where stubbed | Faithful target |
|---|------|-----|--------------|---------------|-----------------|
| T1 | **Per-capability dynamic retry-class dispatch in the workflow** | 🟡 | `proxyActivities` is static per module; the compiled plan's capability node doesn't carry the capability's `SideEffectClass`, so the workflow can't pick the class per call | `apps/workflow-worker/src/workflows.ts` — the ONE capability routed today (`messaging.reply.send`, `sideEffect:'external'`) is pinned to `non-idempotent-guarded-write` | `retry-policy-registry.md` §capability-execution: compile `sideEffect` into the plan's capability node; the interpreter picks one of the per-class proxies at dispatch time |
| T2 | **`WorkflowActivityMetadata` declared locally** | ⚪ | `@platform-internal/tags` (`loopback/binding-tag-registry.md`) doesn't exist — the LoopBack composition layer is unbuilt | `infrastructure/temporal-client/src/retry-policy.ts` — minimal local interface | Import from `@platform-internal/tags` once the LB4 layer lands |
| T3 | **`CATEGORY_BY_CODE` derived, not authored** | 🟡 | `error-contracts.md` has no `code → category` lookup (the spec doc's own Open Question) | `infrastructure/temporal-client/src/retry-policy.ts` | Promote `CATEGORY_BY_CODE` into `contracts/error-contracts.md` (upstream spec change) |
| T4 | **Twilio does not honor the idempotency token** | 🟡 | Twilio Messages API documents no client idempotency key; header sent best-effort | `components/channels/src/sms-transport.ts` `deliver()` sends `idempotency-key` | The real guard is `non-idempotent-guarded-write` `maximumAttempts:1` (in place). If the vendor ever exposes a token, map it; consider a Redis send-ledger pre-check (`redis/idempotency-locks-ratelimits.md`) |
| T5 | **Forced-failure live-Temporal integration tests** | 🟡 | Needs a forced transient-failure harness | `infrastructure/temporal-client/src/retry-policy.spec.ts` covers the unit rows; the spec's 2 integration rows (idempotent-write replay, guarded-write no-auto-retry) not automated | The registry's Testing Strategy integration rows against local Temporal |
| T6 | **No `patched()`/Build-ID worker versioning** | 🔴 | Interpreter control flow must not change without a versioning discipline (triage F9) | no versioning primitives anywhere; interpreter covers 4 of ~10 node kinds | `temporal/worker-versioning-and-replay.md` before the interpreter grows |

## Edge / API gateway

| # | Item | Sev | Why deferred | Where stubbed | Faithful target |
|---|------|-----|--------------|---------------|-----------------|
| E1 | **Raw `node:http` webhook ingress** | 🟡 | Admin REST surface is a later build | `apps/api-gateway/src/server.ts` — thin `node:http` handler for the channel webhook | LoopBack REST controllers per `api/*.md` |
| E2 | **Rule params (`serviceZips`) from a demo config** | 🟡 | Tenant configuration store not built | `apps/api-gateway/src/ingestor.ts`, `index.ts` — per-tenant demo stand-in | Real tenant configuration (`configuration-driven`) |
| E3 | **`to → tenant` resolution is a demo function** | 🟡 | No DID/number registry yet | `apps/api-gateway` / `SmsChannelTransport.tenantByNumber` | A DID/number → tenant registry |

## Vertical fixtures

| # | Item | Sev | Why deferred | Where stubbed | Faithful target |
|---|------|-----|--------------|---------------|-----------------|
| V1 | **`spike-tools.ts` demo `appointment.*` @tool names** | ⚪ | Spike fixtures | `components/agentback-runtime/src/spike-tools.ts` | Real capability-derived tools (Pack E electrician vertical) |

---

## Resolved (kept for one cycle)

| # | Item | Resolved | How |
|---|------|----------|-----|
| R1 | **No explicit Temporal retry policies / duplicate vendor sends on activity retry** (triage F4, 2026-07-13) | ✅ 2026-07-13 | `temporal/retry-policy-registry.md` implemented VERBATIM in `infrastructure/temporal-client` (six classes, generated `NON_RETRYABLE_ERROR_TYPES`, `toApplicationFailure`); all `proxyActivities` sites classed (`internal-db` / `non-idempotent-guarded-write` maxAttempts:1 / `model-call` maxAttempts:1 + heartbeat); workers wrap activities in `withPlatformFailures`; `deliver()` sends the best-effort `idempotency-key` header |
| R2 | **`onPersist` non-atomic (4+ independent transactions per turn)** (triage F3, 2026-07-13) | ✅ 2026-07-13 | `DrizzleTurnPersistence.persistTurnAtomic` — ONE tenant-scoped transaction commits ledger + handoff + audit + usage + a commit-and-publish `event_outbox` row per audit event; write cores (`insertTurnLedger`/`insertHandoffRequest`/`insertAuditEvent`/`insertUsageRecord`/`enqueueOutboxRow`) extracted so the per-repo paths and the atomic path share ONE implementation; itest proves all-or-nothing rollback of a poisoned batch + idempotent replay incl. the outbox |
