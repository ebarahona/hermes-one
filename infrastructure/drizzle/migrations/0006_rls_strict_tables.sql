-- Strict tenant isolation: an unset/blank app.tenant_id GUC yields a NULL predicate → 0 rows,
-- writes rejected. FORCE applies the policy even to the table owner.
-- deployment_members carries no own tenant_id column (matches the DeploymentMember contract); its
-- isolation is enforced by always joining through deployments, never a bare SELECT.
ALTER TABLE substrate.deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE substrate.deployments FORCE ROW LEVEL SECURITY;
CREATE POLICY deployments_tenant_isolation ON substrate.deployments
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE runtime.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY conversations_tenant_isolation ON runtime.conversations
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE runtime.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.messages FORCE ROW LEVEL SECURITY;
CREATE POLICY messages_tenant_isolation ON runtime.messages
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
