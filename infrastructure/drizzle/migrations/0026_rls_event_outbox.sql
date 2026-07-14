-- Strict tenant isolation for the event outbox.
ALTER TABLE event.event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE event.event_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_outbox_tenant_isolation ON event.event_outbox
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
