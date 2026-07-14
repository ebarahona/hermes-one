-- Strict tenant isolation for usage records (mirrors 0006/0012/0014/0016). An unset/blank app.tenant_id
-- GUC yields a NULL predicate → 0 rows and rejected writes; FORCE applies the policy even to the owner.
ALTER TABLE audit.usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.usage_records FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_records_tenant_isolation ON audit.usage_records
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
