---
name: project-hermes-one-gotchas
description: Non-obvious traps hit implementing the tenant provider-mapping override surface (ledger CT3) in hermes-one — relevant to any future spec-to-code transcription in this repo
metadata:
  type: project
---

Building `apps/admin-api/src/provider-mapping.controller.ts` +
`infrastructure/drizzle/src/provider-mapping-repository.ts` (2026-07-17) surfaced three traps worth
knowing before transcribing another `docs/implementation/api/*.md` spec verbatim in hermes-one:

1. **The `Scope` brand regex rejects camelCase.** `packages/contracts/src/tenant.ts`'s `Scope` zod
   schema is `^[a-z][a-z0-9-]*(\.[a-z0-9*-]+){1,2}$` — lowercase + digits + hyphens only, no uppercase.
   `Principal.parse(...)` runs on EVERY authenticated request (`components/auth/src/api-key.strategy.ts`,
   `oidc.strategy.ts`, `principal-mapper.ts`), so a scope literal with a camelCase segment (the API docs
   sometimes write scopes like `tenant.providerMapping.write`) throws a ZodError inside auth and turns
   into a 500 for every request carrying it — not a clean 403. If a spec doc's scope string doesn't match
   the regex, use the kebab-case equivalent (e.g. `tenant.provider-mapping.write`) and leave a "spec
   delta, flagged" comment citing the regex — don't transcribe an unusable scope literally.
   See [[project_hermes_one_conventions]].

2. **`substrate.capability_registrations`'s `capability_name` comes off `definitions.name`, NOT the
   capability contract body's `name` field.** The view (`infrastructure/drizzle/migrations/0027_substrate_reconciliation_views.sql`)
   is `SELECT d.name AS capability_name, ... FROM substrate.definitions d JOIN ... WHERE d.kind =
   'capability'`. `d.name` is the TOP-LEVEL `name` field of `PutDefinitionRequest`
   (`apps/admin-api/src/definition.controller.ts`) — a free-form `z.string().min(1).max(128)`, NOT the
   same value as `body.name` (the branded `CapabilityName`, `domain.resource.action`). Existing itests
   (`definition-route.itest.ts`) deliberately use DIFFERENT values for these two (`itest-slot-read` vs
   `itest.slot.read`) since nothing enforces they match. Anything that queries the view/registrations by
   capability name (e.g. `findContractDefault` in `provider-mapping-repository.ts`) needs the AUTHORING
   request's top-level `name` to equal the capability name being queried — set them equal when authoring
   a test fixture, don't reuse the definition-route.itest fixture's convention of diverging them.

3. **Debugging an unexpected 500 from a live-PG itest**: `PlatformReject`
   (`components/loopback-core/src/sequence/platform-reject.ts`) is the single REST error exit — anything
   that isn't a `PlatformErrorException` collapses to a generic 500 body (`{error: {code:
   'internal_error', ...}}`, no internals leaked) but DOES `console.error('[rest] unhandled error', {err:
   String(err)})` server-side. `pnpm vitest run ... 2>&1 | grep -A3 'unhandled error'` surfaces the real
   cause immediately (e.g. `ResolutionError: The key '...' is not bound to any value in context` when a
   controller injects a binding key that no component in that app's composition root actually provides —
   this is exactly how the spec's `CAPABILITY_REGISTRY` injection in `ProviderMappingController` was
   caught: nothing binds `platform.capability.registry` in `admin-api`'s `AdminApiRoot`, and the routes
   never used it, so it was dropped rather than injected-and-unused).
