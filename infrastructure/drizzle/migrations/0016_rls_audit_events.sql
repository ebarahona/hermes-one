-- Strict tenant isolation for the audit trail (mirrors 0006/0012/0014). An unset/blank app.tenant_id GUC
-- yields a NULL predicate → 0 rows and rejected writes; FORCE applies the policy even to the table owner.
ALTER TABLE audit.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_isolation ON audit.audit_events
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
