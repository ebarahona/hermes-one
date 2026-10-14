-- Seed the platform-defined default roles (the rows a
-- tenant may shadow or extend; tenant_id IS NULL = visible to every tenant via the nullable-tenant RLS
-- policy). Idempotent on the platform partial-unique (roles_platform_name_uq). Scope strings are
-- representative examples; the full leaf catalog grows with capabilities.
INSERT INTO tenant.roles (role_id, tenant_id, name, scopes, description) VALUES
  ('rol_platform_customer', NULL, 'customer',
   '{appointment.slot.read,appointment.booking.create}',
   'Default customer role shipped platform-wide.'),
  ('rol_platform_support_agent', NULL, 'support-agent',
   '{tenant.settings.read,appointment.booking.read,appointment.booking.update,handoff.request.create}',
   'Human support agent: read/update bookings, request handoffs.'),
  ('rol_platform_agent_operator', NULL, 'agent-operator',
   '{admin.definition.read,tenant.settings.read,appointment.booking.create,appointment.booking.read,appointment.booking.update,messaging.reply.send,handoff.request.create}',
   'Operates the agent runtime: booking capabilities + outbound replies + handoffs.'),
  ('rol_platform_service_account', NULL, 'service-account',
   '{webhook.event.ingest}',
   'Minimal machine identity for integrations.'),
  ('rol_platform_inbound_source', NULL, 'inbound-source',
   '{channel.inbound.ingest}',
   'Webhook source principal (kind system) — ingest only, never gates agent tools.')
ON CONFLICT DO NOTHING;
