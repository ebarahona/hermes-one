-- Nullable-tenant isolation: platform-shared (tenant_id IS NULL) rows are readable by every tenant;
-- WITH CHECK never admits NULL, so a platform_app write always carries a concrete tenant_id. Minting
-- a platform-shared row is a distinct privileged path, out of scope here.
ALTER TABLE substrate.definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE substrate.definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY definitions_tenant_isolation ON substrate.definitions
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
