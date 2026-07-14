-- Tenant isolation for the tenant schema. workspaces/users/vertical_pack_installations are strict; roles
-- is nullable-tenant (tenant_id IS NULL = platform-shared role visible to all, mirrors 0007). tenants uses
-- a text-cast compare (tenant_id::text = GUC) so a non-uuid GUC yields no match instead of a cast error —
-- see the flagged uuid-vs-'tnt_' identifier tension in docs/DEFERRED-AND-FLAGGED.md.
ALTER TABLE tenant.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_tenant_isolation ON tenant.tenants
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE tenant.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_tenant_isolation ON tenant.workspaces
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE tenant.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_isolation ON tenant.users
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- Nullable-tenant: platform-defined roles (tenant_id IS NULL) are readable by every tenant; a write must
-- carry a concrete tenant_id (minting a platform role is a distinct privileged path).
ALTER TABLE tenant.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_tenant_isolation ON tenant.roles
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE tenant.vertical_pack_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.vertical_pack_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY vpi_tenant_isolation ON tenant.vertical_pack_installations
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
