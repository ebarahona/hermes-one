# Build plan — from proven thesis to operable multi-tenant platform

> Companion to `DEFERRED-AND-FLAGGED.md` (the exhaustive per-item registry). That file is the *what*;
> this file is the *order and why*. Updated at each phase boundary. Governing laws: **composable**
> (ports in `@platform/contracts`, impls in `infrastructure/*`, planes meet only at serializable
> boundaries, wiring only at composition roots — ADR-017/024) and **scalable** (costs O(1) in tenants
> wherever possible; deterministic-first; nothing on the hot path that breaks at 1,000 tenants).

**State at authoring (2026-07-17):** Tiers 1–3 done · full admin API · AUTH-1→3 · Pack E runs a live
TOOL-BACKED turn from pure data. Ledger: 4 🔴 / 51 🟡 / 13 ⚪. The ledger reads as ~55 problems;
structurally it is **five root causes plus a tail** — most rows are downstream of one of these.

## Phase 0 — Ratify the four blocking decisions ✅ (ADRs 025–028, this commit)

Zero code. Four spec conflicts were found during the build and flagged instead of improvised
(per the spec-fidelity mandate); each now has a ratified answer:

| ADR | Ledger | Decision |
|---|---|---|
| 025 | S5 | ONE `SecretProvider` (the `security/` doc's); refs never name vendors; backend = unpinned config |
| 026 | S6 | Tenant vendor credentials = envelope-encrypted rows under the tenant CMK, NOT secret-manager entries; `resolve()` returns the record; `configKey` deleted |
| 027 | PE4 | `role-matrix.md` governs role scopes; seeded default roles never carry wildcards |
| 028 | A6 | Tool-output evidence is `authoritative/trusted`; `CapabilityInvoker` aligns; `trusted:false` = retrieved-content injection defense |

Follow-through edits owned by later phases: `migrations-and-seed.md:212` (027), `CapabilityInvoker`
stamping (028, Phase 1 since that file is already open there), `table-catalog.md` + secrets doc
amendments (026, Phase 1).

## Phase 1 — The credential spine ✅ (S1 ✅ · S6 ✅ · S7 ✅ · PE7 ✅ 2026-07-17; S2 narrowed to platform secrets; S1a = KMS cipher adapter)

The one build that changes what the product can do: **a second tenant with its own vendor account.**
Today the credential store is env-backed and tenant-agnostic, its PORT is trapped in the edge plane
(`components/channels`, so the agent plane structurally cannot import it — root cause of PE7), and
BOTH planes pass `providerConfig: {}`.

1. ✅ **S7 (structural, DONE 2026-07-17):** move the `ProviderCredentialStore` port to `@platform/contracts`
   beside every other port; create `infrastructure/secrets` (plane `none`) — the member the spec
   already assigns; wire BOTH dead call sites (`agent-activity.ts`, `capability-activities.ts`).
2. ✅ **ADR-026 store (DONE 2026-07-17):** `capability.provider_credentials` table (envelope-encrypted, RLS'd, per
   `(tenant, provider, capability)`), `EnvelopeCredentialStore` in `infrastructure/secrets`, a
   dev-mode local cipher so no cloud account is needed to test — cloud KMS is one adapter behind
   the port, never a prerequisite.
3. ✅ **ADR-028 alignment (DONE 2026-07-17)** (`CapabilityInvoker` evidence stamping) rides along — same files open.
4. ✅ **Proven with Pack E (2026-07-17)** — a tenant rotate() changed live provider output (slots=09:15, not the platform default): the scheduler provider reads per-tenant config through the real chain.
   Real vendor creds (available for testing) enter only as gitignored env for a MANUAL gate.

## Phase 2 — Write-path integrity ✅ (AU2 ✅ · AU4 ✅ 2026-07-17; AU3 moved to the messaging convergence, L1c to the interceptor stack — see ledger)

Two coupled fixes, both about durable truth:
1. ✅ **Replay-stable time (DONE 2026-07-17):** stamp `occurredAt` in the WORKFLOW (Temporal's deterministic clock),
   thread through `TurnRequest` — the audit `integrityHash` covers `occurredAt`, which today is
   wall-clock-fresh per attempt, so tamper-reject (AU2) is UNSAFE until this lands. Contract change
   at the plane boundary; `agent-runtime-contracts.md` governs.
2. ✅ **Atomic substrate writer (DONE 2026-07-17)** ("F3 for the substrate path"): a port + drizzle impl so
   `DeploymentService.publish` / `DefinitionRegistry.put` commit rows AND outbox events in one
   transaction. `definition-substrate` stays pure (depends only on contracts; the composition root
   injects the writer). AU3/AU4's missing audit/domain events become one-line emissions on the seam;
   the Idempotency-Key interceptor (L1c) lands on the same path.

## Phase 3 — The tenant spine 🔄 (CT3 ✅ · CT2 narrowed 2026-07-17; E2/E3 re-scoped — see ledger)

Multi-tenancy is real in the data layer, fake at the edges: `to → tenant` is a demo function, rule
params come from demo config, and tenants cannot override providers because nothing reads
`capability.provider_mappings`. One slice: tenant repos (CT2) + a number→tenant registry (E3) +
resolver merges the DB override ahead of the contract default (CT3) + the admin PUT for overrides +
real tenant configuration (E2). Exit criterion: **tenant #2 is an onboarding row, not a deploy.**

## Phase 4 — Production durability 🔄 (T6 replay-gate ✅ 2026-07-17, dispatch enablement pending; T1 · P2 · I2 · T5)

`patched()`/Build-ID worker versioning BEFORE anything deploys twice (deploying new workflow code
currently breaks in-flight executions); per-capability retry classes compiled into plans (T1); the
Redis-shared circuit breaker when workers go multi-instance (P2); pgbouncer (I2); forced-failure
live-Temporal tests (T5). This phase is what lets you OPERATE at scale.

## Phase 5 — Composition-layer completion + turn quality

LB4 tail (L1/L3b/L3d/L6/L7 — interceptors, sequence, agent-plane components), node:http → REST
ingress (E1), policy `repair` re-compose (A2), `onNoProvider:'handoff'` routed to a real handoff
(PE6), metering from agentback's stream (AU1/OB2), remaining KPIs (OB1). Nothing here blocks
anything above.

## Deliberately out (for now)

P1 (providers/capabilities spec pack — a spec-generation exercise, not a code slice) · T4 (vendor
behavior) · OB6 replay/simulation · the 3 follow-on verticals (after Phases 1–3 make them cheap) ·
S0a/AUTH-4 (blocked upstream on agentback's sync `ConfirmationStore`).

## Working discipline (learned the hard way — see `feedback_hermes_verification_discipline`)

Build → typecheck → plane-lint → test → itest → e2es, IN THAT ORDER (vitest resolves cross-package
imports to dist). Re-run e2es. Assert the durable ledger, not the workflow path. The spec outranks
a review; conflicts get FLAGGED, never silently resolved. One phase in flight at a time; check in
at each phase boundary.
