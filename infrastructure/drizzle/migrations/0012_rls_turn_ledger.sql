-- Strict tenant isolation for the turn ledger (mirrors 0006). An unset/blank app.tenant_id GUC yields a
-- NULL predicate → 0 rows and rejected writes; FORCE applies the policy even to the table owner.
ALTER TABLE runtime.tool_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.tool_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_executions_tenant_isolation ON runtime.tool_executions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE runtime.evidence_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.evidence_records FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_records_tenant_isolation ON runtime.evidence_records
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE runtime.policy_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.policy_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY policy_decisions_tenant_isolation ON runtime.policy_decisions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
