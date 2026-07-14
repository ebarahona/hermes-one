-- Strict tenant isolation for handoff tasks (mirrors 0006/0012). An unset/blank app.tenant_id GUC yields
-- a NULL predicate → 0 rows and rejected writes; FORCE applies the policy even to the table owner.
ALTER TABLE runtime.handoff_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.handoff_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY handoff_tasks_tenant_isolation ON runtime.handoff_tasks
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
