-- message_templates is nullable-tenant (platform templates readable by all, mirrors 0007);
-- workflow_executions_projection is strict tenant isolation.
ALTER TABLE runtime.message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.message_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY message_templates_tenant_isolation ON runtime.message_templates
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE runtime.workflow_executions_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.workflow_executions_projection FORCE ROW LEVEL SECURITY;
CREATE POLICY wep_tenant_isolation ON runtime.workflow_executions_projection
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
