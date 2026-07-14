-- Runtime tables (tenant-owned, RLS 'strict'). Phase scope: conversations + messages.
CREATE SCHEMA IF NOT EXISTS runtime;

CREATE TABLE runtime.conversations (
  conversation_id  text PRIMARY KEY,
  tenant_id        text NOT NULL,
  channel          text NOT NULL,
  principal_id     text,
  status           text NOT NULL DEFAULT 'active',
  opened_at        timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  last_message_at  timestamptz,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE runtime.messages (
  message_id           text PRIMARY KEY,
  tenant_id            text NOT NULL,
  conversation_id      text NOT NULL,
  turn_id              text,
  direction            text NOT NULL,
  channel              text NOT NULL,
  sender_principal_id  text,
  body                 text,
  attachments          jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_message_id  text,
  status               text NOT NULL,
  occurred_at          timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_occurred_idx ON runtime.messages (conversation_id, occurred_at);
CREATE UNIQUE INDEX messages_tenant_provider_msg_uq ON runtime.messages (tenant_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Request-time role privileges (see 0003_substrate_schema.sql).
GRANT USAGE ON SCHEMA runtime TO platform_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA runtime TO platform_app;
