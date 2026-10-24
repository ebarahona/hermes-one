# Build plan: from working proof to an operable multi-tenant platform

> Companion to `DEFERRED-AND-FLAGGED.md`, the full per-item registry. That file is the _what_; this
> file is the _order and why_. It gets updated at each phase boundary. Governing laws: **composable**
> (ports in `@hermes-one/contracts`, impls in `infrastructure/*`, planes meet only at serializable
> boundaries, wiring only at composition roots; ADR-017/024) and **scalable** (costs O(1) in tenants
> wherever possible, deterministic first, nothing on the hot path that breaks at 1,000 tenants).

**State at authoring (2026-07-17):** Tiers 1–3 done · full admin API · AUTH-1→3 · the electrician
pack runs a live tool-backed turn from pure data. Ledger at authoring: 4 🔴 / 51 🟡 / 13 ⚪, from five
root causes plus a tail. **State after the first execution pass (same day): zero unconditional 🔴.**
S0a is 🔴 only under a multi-instance setup that is not yet deployed. Closed/narrowed: S1 S2ⁿ S5 S6 S7
PE4 PE7 A6 AU2 AU4 CT3 CT2ⁿ T6ⁿ (ⁿ = narrowed, remainder flagged). Phases 0–2 ✅ · Phase 3 core ✅
(E2/E3 re-scoped on the ledger) · Phase 4 safety net ✅ (replay gate in CI; versioned dispatch
declared as an options type, not yet wired into the worker). What remains is a different kind of
work. There is one posture decision left (the pre-tenant read, which unblocks E3 + S3 +
CT4-relay together). There are enablement tails that need outside things (a KMS pick, a server
upgrade). The rest is the messaging-convergence bundle (AU3 + S7-residual + P3) and the Phase 5 tail.

**2026-07-22:** a platform-wide engineering review landed. It added definition-substrate validation
at `put()`, compile-time operator verification, deterministic turn identity, turn budget enforcement,
durable credential revocation, the full replay-nonce window, evaluation-gate evidence stamping that
matches production, and authentication-gated API endpoints. The ledger's rows dated 2026-07-22 carry
the detail. Current open totals live in the ledger's header.

## Phase 0: Decide the four blocking questions ✅ (ADRs 025–028, this commit)

No code. Four design conflicts turned up during the build and were flagged instead of improvised.
Each now has an accepted answer:

| ADR | Ledger | Decision                                                                                                                                                  |
| --- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 025 | S5     | One `SecretProvider` (the `contracts/secret.ts` port); refs never name vendors; backend = unpinned config                                                 |
| 026 | S6     | Tenant vendor credentials = envelope-encrypted rows under the tenant CMK, not secret-manager entries; `resolve()` returns the record; `configKey` deleted |
| 027 | PE4    | The role matrix governs role scopes; seeded default roles never carry wildcards                                                                           |
| 028 | A6     | Tool-output evidence is `authoritative/trusted`; `CapabilityInvoker` aligns; `trusted:false` = defense against injection through retrieved content        |

Later phases own the follow-through edits: the seeded default role scopes (027), `CapabilityInvoker`
stamping (028, in Phase 1 since that file is already open there), and the schema addition and
credential-chain documentation (026, Phase 1).

## Phase 1: The credential spine ✅ (S1 ✅ · S6 ✅ · S7 ✅ · PE7 ✅ 2026-07-17; S2 narrowed to platform secrets; S1a = KMS cipher adapter)

This is the one build that changes what the product can do: **a second tenant with its own vendor
account.** Before this phase the credential store was env-backed and tenant-agnostic. Its port lived
in the edge plane (`components/channels`), so the agent plane could not import it at all, which was
the root cause of PE7. Both planes passed `providerConfig: {}`.

1. ✅ **S7 (structural, done 2026-07-17):** move the `ProviderCredentialStore` port to
   `@hermes-one/contracts` beside every other port. Create `infrastructure/secrets` (plane `none`)
   as the home for credential implementations. Wire both call sites (`agent-activity.ts`,
   `capability-activities.ts`).
2. ✅ **ADR-026 store (done 2026-07-17):** the `capability.provider_credentials` table
   (envelope-encrypted, RLS'd, per `(tenant, provider, capability)`), `EnvelopeCredentialStore` in
   `infrastructure/secrets`, and a dev-mode local cipher so you can test without a cloud account.
   Cloud KMS is one adapter behind the port and never a prerequisite.
3. ✅ **ADR-028 alignment (done 2026-07-17)** (`CapabilityInvoker` evidence stamping) came along,
   since the same files were open.
4. ✅ **Proven with the electrician pack (2026-07-17):** a tenant rotate() changed live provider
   output (slots=09:15, not the platform default). The scheduler provider reads per-tenant config
   through the real chain. Real vendor creds (available for testing) enter only as gitignored env for
   a manual gate.

## Phase 2: Write-path integrity ✅ (AU2 ✅ · AU4 ✅ 2026-07-17; AU3 moved to the messaging convergence, L1c to the interceptor stack; see ledger)

Two coupled fixes, both about durable truth:

1. ✅ **Replay-stable time (done 2026-07-17):** stamp `occurredAt` in the workflow (Temporal's
   deterministic clock) and thread it through `TurnRequest`. The audit `integrityHash` covers
   `occurredAt`, which used to be fresh wall-clock time on every attempt. Tamper-reject (AU2) needed
   this to land first. This is a contract change at the plane boundary.
2. ✅ **Atomic definition-substrate writer (done 2026-07-17):** a port plus a drizzle impl, so
   `DeploymentService.publish` / `DefinitionRegistry.put` commit rows and outbox events in one
   transaction. `definition-substrate` stays pure: it depends only on contracts, and the composition
   root injects the writer. AU4's missing audit/domain events become one-line emissions on the seam
   (AU3 moved to the messaging convergence). The Idempotency-Key interceptor (L1c) is to land on the
   same path and is not yet enforced (see ledger).

## Phase 3: The tenant spine 🔄 (CT3 ✅ · CT2 narrowed 2026-07-17; E2/E3 re-scoped; see ledger)

The core shipped. Tenant provider overrides are live end to end (CT3): the resolver merges the DB
override ahead of the contract default, administered via `provider-mapping.controller.ts`. Remaining
scope: a real number→tenant registry for inbound resolution (E3, currently a demo function), tenant
rule-param configuration via compile-time extensions (E2), and the CT2 remainder
(workspaces/onboarding repos). Exit criterion: **tenant #2 is an onboarding row, not a deploy.**

## Phase 4: Production durability 🔄 (T6 replay-gate ✅ 2026-07-17, dispatch enablement pending; T1 · P2 · I2 · T5)

`patched()`/Build-ID worker versioning comes before anything deploys twice. Worker versioning is
what keeps in-flight executions on the interpreter build they started on. Then: per-capability retry
classes compiled into plans (T1), the Redis-shared circuit breaker once workers go multi-instance
(P2), pgbouncer (I2), and forced-failure live-Temporal tests (T5).
This phase is what lets you operate at scale.

## Phase 5: Composition-layer completion + turn quality

LB4 tail (L1/L3b/L3d/L6/L7: interceptors, sequence, agent-plane components), node:http → REST
ingress (E1), policy `repair` re-compose (A2), `onNoProvider:'handoff'` routed to a real handoff
(PE6), metering from agentback's stream (AU1/OB2), and the remaining KPIs (OB1). Nothing here blocks
anything above.

## Deliberately out (for now)

P1 (a documentation pack for providers/capabilities, with no code slice) · T4 (vendor behavior) ·
OB6 replay/simulation · the 3 follow-on verticals (after Phases 1–3 make them cheap) · S0a/AUTH-4
(blocked upstream on agentback's sync `ConfirmationStore`).

## Working discipline

Build → typecheck → plane-lint → test → itest → e2es, in that order (vitest resolves cross-package
imports to dist). Re-run e2es. Assert the durable ledger, not the workflow path. The architecture
(ADRs) outranks a review. Conflicts get flagged and are never silently resolved. Keep one phase in
flight at a time, and check in at each phase boundary.
