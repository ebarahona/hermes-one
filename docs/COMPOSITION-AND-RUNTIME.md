# Composition and runtime configuration

How hermes-one is wired (inversion of control, dependency injection, ports and adapters) and what
can change at runtime without a code change or a deploy. Every statement points at the code that
implements it; where something is designed but not built, it says so and names the ledger row in
`docs/DEFERRED-AND-FLAGGED.md`.

The summary lives in the README's **IoC, DI, and dynamic composition** section; this is the full
map.

## 1. Two planes, one IoC idiom

The **edge plane** (webhook ingest, the admin API, the workflow and activity workers) runs on
LoopBack 4 (`@loopback/core`, `@loopback/context`). The **agent plane** (the bounded agent turn)
runs on [agentback](https://github.com/ninemindai/agentback), built on the same context/binding
model. The two never share a live context (ADR-017). They exchange only serializable data:
`TurnRequest` / `TurnResult` (`packages/contracts/src/agent-runtime.ts`), carrying the
`WorkspaceContext` (tenant runtime, deployment pin, principal) as Temporal activity input and
output on the agent task queue (`apps/workflow-worker/src/workflows.ts`), plus Postgres and Redis.
There is no bridge package; the principal crosses as plain data.

Every workspace package carries a `"hermes"` descriptor in its `package.json`
(`name`, `role`, `plane`, `published`, `governedBy`):

| Plane   | Members                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------ |
| `edge`  | `admin-api`, `api-gateway`, `workflow-worker`, `activity-worker`, `loopback-core`, `auth`, `channels`, `analytics` |
| `agent` | `agent-worker`, `agent-runtime`, `agentback-runtime`, `tool-executor`, `evaluation`                                |
| `none`  | every `packages/*` and `infrastructure/*` member                                                                   |

`pnpm plane-lint` (`tools/plane-lint.ts`, part of `pnpm verify` and CI) fails if an edge member
runtime-imports `@agentback/*` or an agent member runtime-imports `@loopback/*`; `import type` is
allowed. It checks those two framework scopes, not workspace-package planes, and skips `none`
members.

## 2. Binding keys

Platform-wide edge-plane keys are declared once, typed, in `PlatformBindings`
(`components/loopback-core/src/bindings.ts`), named `platform.<area>.<name>`. Auth keys live beside
it in `AuthBindings` (`components/auth/src/auth.bindings.ts`, `platform.auth.*`, plus the
`platform.extensions.authStrategies` extension point), and the public-path list in
`components/loopback-core/src/sequence/rest-bindings.ts` (`platform.rest.public-paths`).

| Area            | Keys                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| Capability      | `platform.capability.registry`, `.resolver`, `.invoker`, `.providerMappingRepository`; `platform.provider.registry` |
| Runtimes        | `platform.rule.runtime`, `platform.policy.runtime`                                                                  |
| Data            | `platform.data.postgres`, `platform.data.redis`, and the `platform.data.*` repositories                             |
| Definitions     | `platform.definition.registry`, `platform.definition.deploymentService`                                             |
| Audit and usage | `platform.audit.sink`, `platform.usage.meter`                                                                       |
| Telemetry       | `platform.telemetry.logger`, `platform.telemetry.meter`                                                             |
| Tenant          | `platform.tenant.roleRegistry`                                                                                      |
| Request         | `platform.request.principal`, `platform.request.correlation-id`                                                     |
| Config          | `platform.config.root`                                                                                              |
| Extension point | `platform.extensions.providerAdapters`                                                                              |

A key is declared only once its port type exists; keys for unbuilt ports (Temporal, Qdrant, tracer,
tenant resolver, memory) are deliberately absent (ledger L4). A few declared keys are not bound by
any app yet (`WORKFLOW_RUNTIME`, `TOOL_EXECUTOR`, `TENANT_ID`, `REQUEST_LOCALE`, `REQUEST_CHANNEL`,
`EVENT_OUTBOX_PUBLISHER`) and `tenantKey()` (per-tenant keys) has no caller.

## 3. Components

Every component implements `PlatformComponentBoundary`
(`components/loopback-core/src/boundary.ts`): it declares its plane, the keys it binds, and the
extension points it implements or consumes. For the core components (observability, persistence,
capability registry, rule and policy runtimes), `composition.spec.ts` checks that every declared key
is bound under the `platform.*` prefix. Most bindings are singletons built with `toDynamicValue`
from other bindings; `AuthComponent` binds classes, and its principal mapper is request-scoped.

| Component                     | What it binds                                                                                                                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PersistenceComponent`        | the Postgres pool and Redis client, the Drizzle adapters over one pool, and two `datasource` lifecycle observers; Postgres runs the fail-closed RLS boot gate (`assertNonBypassingRole` + tenant GUC preflight) before any server listens |
| `SubstrateComponent`          | `DefinitionRegistry` and `DeploymentService`, with the workflow, rule, and policy compilers (rule and policy pinned to the operator registry)                                                                                             |
| `CapabilityRegistryComponent` | the capability registry, the `ProviderRegistry` (adapters discovered by tag), and the `CapabilityInvoker`, which consults tenant provider mappings when bound                                                                             |
| `RuleRuntimeComponent`        | the rule runtime over the operator registry                                                                                                                                                                                               |
| `PolicyRuntimeComponent`      | the policy runtime (exported; no app registers it yet; the agent turn constructs its policy runtime directly)                                                                                                                             |
| `ObservabilityComponent`      | the JSON logger and meter (no tracer binding; tracing is initialized by the api-gateway and the agent worker)                                                                                                                             |
| `ChannelComponent`            | provider adapters for messaging: the internal message log always, the SMS vendor adapter only when `SMS_VENDOR` is configured                                                                                                             |
| `AuthComponent`               | the strategy registry, the request-scoped principal mapper, and the `api-key` and `oidc` strategies as extensions                                                                                                                         |

## 4. Extension points

- **Provider adapters.** Components contribute `ProviderAdapter` bindings tagged
  `extensionFor: platform.extensions.providerAdapters`; `CapabilityRegistryComponent` collects them
  with `context.findByTag` into the `ProviderRegistry`. A new vendor for an existing capability is
  a new adapter binding. On the agent plane the registry is still a fixed list
  (`new ProviderRegistry([new InternalSchedulerProvider()])` in `apps/agent-worker/src/agent-activity.ts`).
- **Authentication strategies.** `AuthStrategyRegistry`
  (`components/auth/src/auth-strategy.registry.ts`) is an `@extensionPoint` that receives every
  strategy through `@extensions`. The first strategy whose `applies()` matches the request
  authenticates it; if none applies, the request fails closed. A new scheme is a new strategy
  binding.

The expression language's operators are a static, versioned list
(`packages/expression-core/src/registry.ts`); loading operators as extensions is not built.

## 5. The REST sequence and request scope

`registerPlatformRestSequence` (`components/loopback-core/src/sequence/register.ts`) configures
LoopBack's middleware sequence with ordered groups: `sendResponse → cors → middleware →
correlation → authentication → API_SPEC → findRoute → parseParams → invokeMethod`, and replaces the reject
action with `PlatformReject`, the single `{error: PlatformError}` exit.

- `CorrelationMiddleware` binds the correlation id into the request context and echoes
  `X-Correlation-Id`.
- `FailClosedAuthenticationMiddleware` runs the strategy registry on every non-public route
  (health is the only public path by default). `API_SPEC` is ordered after authentication, so the
  OpenAPI document is not public (ledger E4).
- `DefaultPrincipalMapper` is request-scoped and is the only writer of
  `platform.request.principal`; controllers inject the principal.
- The tenant comes from the principal: controllers reject a path tenant that differs from
  `principal.tenantId`, and authorization is an inline `assertScope(principal, scope)` per route.

The other planned groups (tenant resolution, edge authorization, rate limit, locale/channel,
idempotency, tenant transaction, metering, audit, tracing) are declared in `sequence-groups.ts` but not mounted, and
there are no interceptors yet (ledgers L3b, L3d, L7).

## 6. Composition roots

`CompositionRoot<TApp>` (`packages/contracts/src/composition-root.ts`) is the plane-neutral
contract: `createApp`, `bindPorts`, `registerComponents`, `start` (fail-closed), `serve`, `stop`.
`bootstrap()` (`components/loopback-core/src/bootstrap.ts`) loads config once (env, Zod-validated)
and runs the phases, exiting on any failure.

| App               | How it is composed                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin-api`       | `AdminApiRoot` (a `CompositionRoot`, run by `bootstrap()`): binds config, auth config, the API-key store, and the JWT verifier when supplied (`main.ts` builds both from `HERMES_ADMIN_API_KEYS` and `HERMES_OIDC_ISSUERS`); registers the REST sequence, `AuthComponent`, `PersistenceComponent`, `SubstrateComponent`, and eight controllers |
| `workflow-worker` | `WorkflowWorkerRoot` (a `CompositionRoot`): a bare context that binds only config, since workflow code does no I/O                                                                                                                                                                                                                             |
| `activity-worker` | a `PlatformApplication` with observability, persistence, capability registry, rule runtime, and channels; activities are factories closed over dependencies resolved from that container                                                                                                                                                       |
| `api-gateway`     | `createInboundGateway()`, started by `main.ts` from config: a `PlatformApplication` with observability and persistence; the Temporal client, SMS transport, secret provider, and nonce store are built inline (not yet a `CompositionRoot`)                                                                                                    |
| `agent-worker`    | an agentback `MCPApplication` plus a memoized `boot()` that builds the model client, stores, persistence, and tracing with factories (ledger L2)                                                                                                                                                                                               |

Adapter selection is code, with three switches from configuration: the SMS vendor adapter
(`SMS_VENDOR`), the envelope credential store (`HERMES_CREDENTIALS_MASTER_KEY`), and the trace
exporter (`HERMES_OTEL_TRACES`).

## 7. Ports and adapters

Most ports live in `@hermes-one/contracts`; the model port is in `infrastructure/model-client` and
the `Tracer` port in `infrastructure/telemetry`. Adapters live in `infrastructure/`, `components/`,
and `packages/` (the rule and policy runtimes, the in-memory capability registry). Some bound
services are concrete classes rather than ports (`DefinitionRegistry`, `DeploymentService`, the
compiled plan store).

| Port                      | Adapters                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `AuditSink`               | `DrizzleAuditSink` (append-only, per-event integrity hash)                            |
| `UsageMeter`              | `DrizzleUsageMeter`                                                                   |
| `RoleRegistry`            | `DrizzleRoleRegistry`                                                                 |
| `EventOutboxRepository`   | Drizzle (transactional outbox)                                                        |
| `EventPublisher`          | `RedisPubSubEventPublisher`                                                           |
| `NonceStore`              | `RedisNonceStore`                                                                     |
| `SecretProvider`          | `EnvSecretProvider` (`secret://env/...`)                                              |
| `ProviderCredentialStore` | `EnvelopeCredentialStore`, `StaticProviderCredentialStore`, `FallbackCredentialStore` |
| `Logger`                  | `JsonLogger`, `RedactingLogger`                                                       |
| `Meter`                   | `LoggingMeter`, `InMemoryMeter`                                                       |
| `Tracer`                  | `OtelTracer`, `NoopTracer`                                                            |
| `RuleRuntime`             | the rule-dsl runtime                                                                  |
| `PolicyRuntime`           | `ExpressionPolicyRuntime`                                                             |
| `CapabilityRegistry`      | `InMemoryCapabilityRegistry`, `IndexedCapabilityRegistry`                             |
| `ToolExecutor`            | `PlatformToolExecutor`                                                                |
| `ChannelTransport`        | `SmsChannelTransport`                                                                 |
| `ApiKeyStore`             | `StaticApiKeyStore`                                                                   |
| `JwtVerifier`             | `JoseJwtVerifier`                                                                     |
| `PrincipalMapper`         | `DefaultPrincipalMapper`                                                              |
| `ProviderAdapter`         | `PersistingMessageProvider`, `VendorSmsProvider`, `InternalSchedulerProvider`         |
| `SingleStepModel`         | `createOpenAICompatibleModel` (any OpenAI-compatible endpoint)                        |

Declared ports with no adapter yet: `WorkflowRuntime`, `HandoffService`, `ReplayService`,
`SimulationService`, `SessionStore`, `WebhookSignatureVerifier`, `ServiceIdentityVerifier`.

## 8. The agent plane, per turn

The agent worker serves every tenant, so tools are projected per turn, not per process. Steps 1–3
run in `apps/agent-worker/src/agent-activity.ts`; step 4 is
`components/agentback-runtime/src/tool-projection.ts`:

1. The turn loads its **pinned** deployment by id and takes the engine's `allowedCapabilities`.
2. `capabilitiesForEngine` keeps only the capabilities the engine allows and the principal's scopes
   cover (ADR-019).
3. Tenant provider-mapping overrides are applied to those contracts.
4. `CapabilityToolProjector` builds one class per turn with a method per capability and applies
   agentback's `@tool` decorator programmatically; input and output JSON Schema become Zod
   (`json-schema-to-zod.ts`). The tool body resolves the ranked adapter, the tenant's credentials,
   and calls the provider. A contract that cannot be converted is skipped and reported.
5. `PlatformToolExecutor` (`components/tool-executor/src/executor.ts`) dispatches through
   agentback's MCP server with a per-dispatch child context; an envelope hook records timing and
   deterministic evidence ids, and the executor synthesizes the `ToolResult` from the contract and
   the hook. It surfaces pending confirmations and `onNoProvider: handoff` as turn outcomes.

The turn itself (`components/agent-runtime/src/turn.ts`) is a bounded single-step loop: budgets
(steps, deadline, input/output tokens, cost) are checked before each model call, the policy
pre-gate screens each proposed tool call, and the post-gate screens the reply, with at most one
repair.

## 9. Temporal workers

- `workflow-worker` registers the workflow bundle on `hermes-workflow` with no activities. The
  workflows reach activities by name through `proxyActivities`, each with a retry class from the
  retry-policy registry (`internal-db`, external capability classes, `model-call`).
- `activity-worker` registers rule, plan, capability, and decision activities, each a factory
  closed over container-resolved dependencies and wrapped so failures map to platform errors.
- `agent-worker` registers the `agentTurn` activity; its dependencies come from the memoized boot.

The host workflows are `runCompiledWorkflow` and `runAgentWorkflow`; `selectHostWorkflow`
(`apps/workflow-worker/src/host.ts`) picks the agent host when the compiled entry plan contains an
agent node.

## 10. What is dynamic at runtime

### Definitions

Five definition kinds (`packages/contracts/src/substrate.ts`): workflow, rule, and policy (logic
DSLs, compiled) and capability and agent-engine (contract schemas, Zod-validated).
`DefinitionRegistry.put()` (`packages/definition-substrate/src/registry.ts`, behind
`PUT /v1/definitions/{id}`) compiles or validates, computes a content hash over canonical JSON
(`sha256:`), and derives the plan id from the hash. The compiled plan store is content-addressed and
insert-only, with a Redis cache; the cache-through reads check that the stored content hash matches
the requested one, and a mismatch is a hard error. Compiled rule and policy plans pin the operator
versions they use, and the rule runtime refuses a plan when any pinned operator version differs from
the live registry.

Definitions are always written as published; the draft, validated, compiled, deployed, and retired
lifecycle states are defined but not used.

### Deployments

`POST /v1/deployments/preview` validates a manifest structurally; `POST /v1/deployments` publishes
(atomic supersede + insert + `deployment.published` event, then the active pointer's cache entry is
dropped); `POST /v1/deployments/{tenant}/rollback` repoints the active deployment at an earlier
version's members by minting a new version. A publish takes effect on the next inbound message.

The ingest edge resolves the tenant's active deployment and **pins** it on the run
(`apps/api-gateway/src/ingestor.ts`); the agent turn loads that pinned deployment by id. A publish
in the middle of a conversation does not change a run already in flight.

The optional regression gate (`composeCandidateRegressionCheck`) runs before a publish is written
when it is wired; today that is the demo publish path (`apps/workflow-worker/src/publish.ts`), not
the admin API.

### Vertical packs

A pack (`verticals/*/pack.json`) is a manifest plus definitions of the five kinds. Installing one is
authoring its definitions and publishing a deployment, either through the admin API (`PUT
/v1/definitions/{id}` for each, then `POST /v1/deployments`, as `apps/admin-api/src/pack-e.itest.ts`
does) or with the generic `installVerticalPack` (`apps/workflow-worker/src/pack-e-install.ts`),
which is used by the end-to-end tests. Nothing in the installer is vertical-specific.

### Providers and credentials

Capability contracts are provider-neutral. `ProviderResolver`
(`packages/capability-contract/src/resolver.ts`) applies the contract's eligibility rules, ranks
providers by priority, and picks the first registered adapter that is available and whose circuit
is not open; otherwise the capability's `onNoProvider` decides (fail, or hand off on the agent plane).
A tenant's override (`capability.provider_mappings`; read with
`GET /v1/capabilities/{name}/provider-mapping?tenantId=`, written with `PUT`/`DELETE
/v1/tenants/{t}/capabilities/{name}/provider-mapping`) is read uncached: on every invocation on the
edge plane, and once per capability when each agent turn is assembled. A change applies to the next
call (edge) or the next turn (agent), including in conversations already running. Overrides are
not pinned to the deployment.

Tenant vendor credentials are envelope-encrypted rows in `capability.provider_credentials`
(ADR-026), resolved and decrypted on every call with no cache; `rotate()` and `revoke()` apply to
the next resolution, and a revoked row never falls back to platform credentials. This applies when
`HERMES_CREDENTIALS_MASTER_KEY` is set; without it both workers use static, environment-backed
stores. The scheduler capability on the agent plane resolves tenant credentials this way (verified by
`pack-e.e2e.ts`); edge-plane SMS sends do not yet (section 12).

### Identity

Roles resolve to scopes on every OIDC request and every inbound message (the ingest edge mints the
customer principal and resolves its scopes), uncached, with tenant role rows shadowing platform
rows of the same name. A role change applies to the next request; an agent run keeps the scopes it
started with. API-key principals carry fixed scopes on the key record.

### Agent engines

The engine definition's `allowedCapabilities`, `model.model`, and `model.temperature` drive each
turn; an empty model falls back to `LLM_MODEL`.

## 11. Not dynamic yet

- **Tenant configuration.** Turn budgets, quotas, the tenant profile, locale, and handoff routing
  come from code defaults (`apps/workflow-worker/src/turn-request.ts`,
  `apps/agent-worker/src/agent-activity.ts`). `PATCH /v1/tenants/{t}` persists and emits
  `tenant.config.changed`, but turns do not read it yet.
- **Rule parameter values** come from the gateway's `parametersFor`, which the entry point
  (`apps/api-gateway/src/main.ts`) fills from `HERMES_RULE_PARAMETERS`. Tenant overrides are planned to merge at compile time through rule extension
  definitions, not through a runtime config table (E2).
- **Engine fields** `persona`, `objectives`, `referencedRules`, `promptTemplateIds`, and
  `model.provider` are stored but not read; there is one LLM endpoint per worker process (A11, CT6).
- **Admin routes** for credential rotation, pack install, and role update/delete do not exist; those
  operations are library calls today.
- **The adapter set** is code (section 6), and operators are a static list (section 4).
- **Platform configuration** is read from the environment once at boot; changing it needs a
  restart.

## 12. Known gaps in the wiring

Found while writing this document.

- Admin API keys come from `HERMES_ADMIN_API_KEYS` into the static key store, the interim store
  tracked as S3, until the DB-backed key store lands.
- On the edge plane, `ChannelComponent` builds the SMS vendor adapter with its own environment-backed
  credential store, and `VendorSmsProvider` resolves from it and overrides the provider config the
  activity worker passes in, so SMS sends use platform credentials, not the tenant's
  envelope-encrypted ones. Tracked in ledger S7 ("VendorSmsProvider still self-resolves").
- The inbound number → tenant map comes from `HERMES_GATEWAY_NUMBERS` until the tenant registry
  owns channel numbers.
