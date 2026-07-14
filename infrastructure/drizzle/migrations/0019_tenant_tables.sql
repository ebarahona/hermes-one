-- The `tenant` schema: tenants (reused from repository-patterns.md + slug unique), workspaces, users,
-- roles, vertical_pack_installations. Columns verbatim from database/table-catalog.md. Partial-unique
-- indexes (not expressible in the Drizzle DSL) are hand-authored here per constraints.md.
CREATE SCHEMA IF NOT EXISTS tenant;

CREATE TABLE tenant.tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,                                  -- self-referencing (tenant_id = id)
  slug           text NOT NULL,
  display_name   text NOT NULL,
  status         text NOT NULL,
  data_residency text NOT NULL,
  features       jsonb NOT NULL DEFAULT '{}'::jsonb,
  version        integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenants_tenant_id_idx ON tenant.tenants (tenant_id);
CREATE UNIQUE INDEX tenants_slug_uq ON tenant.tenants (slug);
ALTER TABLE tenant.tenants ADD CONSTRAINT tenants_status_ck
  CHECK (status IN ('active','suspended','trial','archived'));
ALTER TABLE tenant.tenants ADD CONSTRAINT tenants_residency_ck
  CHECK (data_residency IN ('us','eu','apac'));

CREATE TABLE tenant.workspaces (
  workspace_id     text PRIMARY KEY,
  tenant_id        text NOT NULL,
  conversation_id  text,
  channel          text NOT NULL,
  principal_id     text,
  deployment_id    text,
  status           text NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant.workspaces ADD CONSTRAINT workspaces_channel_ck
  CHECK (channel IN ('sms','whatsapp','webchat','email','voice','api'));
ALTER TABLE tenant.workspaces ADD CONSTRAINT workspaces_status_ck CHECK (status IN ('active','closed'));

CREATE TABLE tenant.users (
  principal_id          text PRIMARY KEY,
  tenant_id             text NOT NULL,
  kind                  text NOT NULL,
  display_name          text,
  email                 text,
  auth_provider         text,
  auth_subject          text,
  external_handle       text,
  role_names            text[] NOT NULL DEFAULT '{}',
  attributes            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'active',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  last_authenticated_at timestamptz
);
CREATE INDEX users_tenant_id_idx ON tenant.users (tenant_id);
CREATE INDEX users_tenant_kind_idx ON tenant.users (tenant_id, kind);
CREATE UNIQUE INDEX users_tenant_auth_identity_uq ON tenant.users (tenant_id, auth_provider, auth_subject)
  WHERE auth_subject IS NOT NULL;
CREATE UNIQUE INDEX users_tenant_external_handle_uq ON tenant.users (tenant_id, external_handle)
  WHERE external_handle IS NOT NULL;
CREATE UNIQUE INDEX users_tenant_email_uq ON tenant.users (tenant_id, email)
  WHERE email IS NOT NULL;
ALTER TABLE tenant.users ADD CONSTRAINT users_kind_ck CHECK (kind IN ('user','service','system'));
ALTER TABLE tenant.users ADD CONSTRAINT users_status_ck CHECK (status IN ('active','suspended'));
ALTER TABLE tenant.users ADD CONSTRAINT users_auth_provider_ck
  CHECK (auth_provider IS NULL OR auth_provider IN ('oidc','oauth2','api-key','signed-webhook','service-identity'));

CREATE TABLE tenant.roles (
  role_id     text PRIMARY KEY,
  tenant_id   text,                                              -- NULL = platform-defined
  name        text NOT NULL,
  scopes      text[] NOT NULL DEFAULT '{}',
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_tenant_name_uq ON tenant.roles (tenant_id, name);
CREATE UNIQUE INDEX roles_platform_name_uq ON tenant.roles (name) WHERE tenant_id IS NULL;

CREATE TABLE tenant.vertical_pack_installations (
  installation_id       text PRIMARY KEY,
  tenant_id             text NOT NULL,
  pack_id               text NOT NULL,
  pack_version          text NOT NULL,
  status                text NOT NULL,
  installed_definitions jsonb NOT NULL DEFAULT '[]'::jsonb,
  config                jsonb NOT NULL DEFAULT '{}'::jsonb,
  installed_by          text NOT NULL,
  installed_at          timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vpi_tenant_pack_uq ON tenant.vertical_pack_installations (tenant_id, pack_id);
ALTER TABLE tenant.vertical_pack_installations ADD CONSTRAINT vpi_status_ck
  CHECK (status IN ('installing','active','disabled','failed'));

GRANT USAGE ON SCHEMA tenant TO platform_app;
GRANT SELECT, INSERT, UPDATE ON tenant.tenants TO platform_app;
GRANT SELECT, INSERT, UPDATE ON tenant.workspaces TO platform_app;
GRANT SELECT, INSERT, UPDATE ON tenant.users TO platform_app;
GRANT SELECT, INSERT, UPDATE ON tenant.roles TO platform_app;
GRANT SELECT, INSERT, UPDATE ON tenant.vertical_pack_installations TO platform_app;
