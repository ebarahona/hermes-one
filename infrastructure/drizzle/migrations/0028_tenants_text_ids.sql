-- CT1 (DECIDED by the user 2026-07-14, docs/design/001-edge-authn-design.md Open Questions):
-- tenant identifiers are the TEXT brands (`tnt_…`) EVERYWHERE. tenant.tenants was the one table keyed
-- by uuid while every GUC, RLS predicate, contract brand, and
-- other table keys on the text brand — so a text-GUC session saw ZERO tenant rows (fail-closed defect,
-- ledger CT1). This migration converts the two uuid columns to text and recreates the RLS policy
-- without the ::text cast. Recorded as a deliberate deviation from the base repository pattern.
--
-- Existing rows: tenant.tenants has NO runtime consumers yet (ledger CT2 — schema-complete only) and
-- every pre-CT1 row was unreachable under RLS from the request path (the fail-closed mismatch above);
-- any rows present are itest residue seeded by the owner connection. They are removed rather than
-- given invented brand ids.
DELETE FROM tenant.tenants;

-- The policy references tenant_id — Postgres refuses ALTER TYPE on a policy-bound column, so the
-- policy drops first and is recreated (without the ::text cast) after the type change. The whole
-- migration is one transaction (migrate.ts), so RLS is never observably absent.
DROP POLICY tenants_tenant_isolation ON tenant.tenants;

ALTER TABLE tenant.tenants ALTER COLUMN id DROP DEFAULT;
ALTER TABLE tenant.tenants ALTER COLUMN id TYPE text USING id::text;
ALTER TABLE tenant.tenants ALTER COLUMN tenant_id TYPE text USING tenant_id::text;

-- Brand-shape backstops (the app mints ids; these catch a raw-uuid regression at the boundary).
ALTER TABLE tenant.tenants ADD CONSTRAINT tenants_id_brand_ck CHECK (id LIKE 'tnt\_%');
ALTER TABLE tenant.tenants ADD CONSTRAINT tenants_tenant_id_brand_ck CHECK (tenant_id LIKE 'tnt\_%');

-- RLS: plain text comparison now that the types agree (was tenant_id::text = GUC).
CREATE POLICY tenants_tenant_isolation ON tenant.tenants
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
