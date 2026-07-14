-- runtime.message_templates (tenant_id IS NULL = platform template) + runtime.workflow_executions_projection
-- (Postgres read-model of Temporal executions; Temporal remains the source of truth). Columns verbatim
-- from database/table-catalog.md.
CREATE TABLE runtime.message_templates (
  template_id          text PRIMARY KEY,
  tenant_id            text,                                     -- NULL = platform template
  channel              text NOT NULL,
  name                 text NOT NULL,
  provider_template_id text,
  body                 text NOT NULL,
  variables            jsonb NOT NULL DEFAULT '{}'::jsonb,
  locale               text NOT NULL DEFAULT 'en-US',
  status               text NOT NULL DEFAULT 'draft',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mt_tenant_channel_name_uq ON runtime.message_templates (tenant_id, channel, name);
CREATE UNIQUE INDEX mt_platform_channel_name_uq ON runtime.message_templates (channel, name) WHERE tenant_id IS NULL;
ALTER TABLE runtime.message_templates ADD CONSTRAINT mt_channel_ck
  CHECK (channel IN ('sms','whatsapp','webchat','email','voice'));
ALTER TABLE runtime.message_templates ADD CONSTRAINT mt_status_ck CHECK (status IN ('draft','active','retired'));

CREATE TABLE runtime.workflow_executions_projection (
  workflow_run_id     text PRIMARY KEY,
  workflow_id         text NOT NULL,
  tenant_id           text NOT NULL,
  deployment_id       text NOT NULL,
  deployment_version  text NOT NULL,
  plan_id             text NOT NULL,
  workspace_id        text,
  conversation_id     text,
  status              text NOT NULL,
  current_node_id     text,
  outcome             jsonb,
  correlation_id      text NOT NULL,
  started_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);
CREATE INDEX wep_tenant_status_idx ON runtime.workflow_executions_projection (tenant_id, status);
CREATE INDEX wep_tenant_workflow_id_idx ON runtime.workflow_executions_projection (tenant_id, workflow_id);
CREATE INDEX wep_conversation_idx ON runtime.workflow_executions_projection (conversation_id);
ALTER TABLE runtime.workflow_executions_projection ADD CONSTRAINT wep_status_ck
  CHECK (status IN ('running','completed','handoff','abandoned','failed','terminated','continued_as_new'));

GRANT SELECT, INSERT, UPDATE ON runtime.message_templates TO platform_app;
GRANT SELECT, INSERT, UPDATE ON runtime.workflow_executions_projection TO platform_app;
