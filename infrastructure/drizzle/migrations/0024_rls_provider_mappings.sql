-- Strict tenant isolation for capability provider-mapping overrides.
ALTER TABLE capability.provider_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE capability.provider_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_mappings_tenant_isolation ON capability.provider_mappings
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
