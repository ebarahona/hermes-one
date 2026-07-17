---
name: project-hermes-one-conventions
description: Repo-wide conventions for hermes-one (pnpm monorepo) — Drizzle repo/binding/controller triad, RLS tenant-scoping, itest patterns
metadata:
  type: project
---

hermes-one is the Hermes agentic-platform monorepo (pnpm workspaces: apps/, components/,
infrastructure/, packages/). Every tenant-owned Postgres table follows the SAME three-layer pattern —
match it exactly rather than improvising:

1. **Drizzle repo** (`infrastructure/drizzle/src/<name>-repository.ts`): a class extending
   `TenantAwareRepository` (`tenant-aware.repository.ts`). Every method wraps its body in
   `this.withTenant({tenantId}, async tx => {...})`, which opens a transaction, does a parameterized
   `set_config('app.tenant_id', tenantId, true)` (== SET LOCAL, safe under pgbouncer), and RLS enforces
   the boundary. Fails CLOSED (403) if tenantId is blank — never issues SQL. Export the class + a
   `create<Name>Repository(pgUrl, opts) -> {repo, close}` factory from `client.ts`, then re-export both
   (class + factory + Handle type) from `infrastructure/drizzle/src/index.ts`.
2. **Binding** (`components/loopback-core/src/bindings.ts` + `components/loopback-core/src/components/persistence.component.ts`):
   add a `BindingKey.create<DrizzleXRepository>('platform.<area>.<name>')` to the `PlatformBindings`
   namespace (grammar: `platform.<area>.<camelCaseName>`), add its `.key` to `PersistenceComponent.bindsKeys`,
   and add a `Binding.bind(...).toDynamicValue(({context}) => new DrizzleXRepository(context.getSync(PlatformBindings.POSTGRES).db)).inScope(BindingScope.SINGLETON)` entry — same shared PG pool every other
   repo binding uses. New/unusual keys get an inline "new key, flagged" comment (see [[project_hermes_one_gotchas]]).
3. **Controller** (`apps/admin-api/src/<name>.controller.ts`): inject `PlatformBindings.REQUEST_PRINCIPAL`
   and the repo binding. Own-tenant boundary is ALWAYS enforced server-side — a private
   `assertOwnTenant(tenantId, scope)` helper calls `assertScope(principal, scope)` (throws 403
   `forbidden_scope`) then compares `tenantId !== principal.tenantId` (throws the same 403 — never
   leaks which check failed). Zod-validate request bodies with `.safeParse`; a `validationFailed(err)`
   helper turns `ZodError` into a `PlatformErrorException` (category 'validation', code
   'validation_failed', httpStatus 422). Not-found repo misses throw a `PlatformErrorException`
   (category 'not-found', code 'not_found', httpStatus 404). Register the controller in
   `apps/admin-api/src/root.ts`'s `registerComponents` via `app.controller(XController)`.

**PlatformErrorException is the ONLY error type that survives to the wire intact** — `PlatformReject`
(`components/loopback-core/src/sequence/platform-reject.ts`) collapses anything else to a generic 500
and `console.error('[rest] unhandled error', {err: String(err)})`s it server-side. When an itest gets an
unexpected 500, grep the vitest stdout for `[rest] unhandled error` — the real cause (e.g. a
ResolutionError for an unbound binding key) is right there, not in the HTTP response body.

**Raw SQL / views**: Drizzle views aren't modeled in the schema files (not DDL, not in the drift gate).
Read them via `tx.execute(sql\`SELECT ... FROM schema.the_view WHERE ...\`)` inside `withTenant`, same
as `rls-self-check.ts`'s GUC probes. `res.rows[0]` is the row (`pg` auto-parses `jsonb` columns to JS
objects/arrays).

**Live-PG itests** (`*.itest.ts`, run via `pnpm vitest run --config vitest.itest.config.ts <path>`):
boot a real `AdminApiRoot` with `apiKeySeeds` (static API keys carrying specific `Scope[]`), seed/clean
up rows directly via a `pg.Pool` in `beforeAll`/`afterAll` (own-tenant GUC set first), assert over real
HTTP via `fetch`. Migrations are NOT auto-applied by the itest config (no globalSetup) — they self-apply
inside `runMigrations()` calls that individual `infrastructure/drizzle/src/*.itest.ts` files run in their
own `beforeAll`. Run any one of those once (e.g. `provider-credentials.itest.ts`) to apply pending
migrations against the live compose Postgres before an app-level route itest that assumes the new DDL/grants exist.

See [[project_hermes_one_gotchas]] for the specific traps hit building the provider-mapping override
surface (ledger CT3).
