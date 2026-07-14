-- Content-addressed compiled-plan substrate: six tables in the `substrate` schema.
-- compiled_plans / validated_contracts are keyed solely by content_hash (insert-only, dedupe).
CREATE SCHEMA IF NOT EXISTS substrate;

CREATE TABLE substrate.definitions (
  definition_id    text PRIMARY KEY,
  tenant_id        text,                       -- NULL == platform-owned (shared) definition
  kind             text NOT NULL,
  name             text NOT NULL,
  schema_ref       text NOT NULL,
  current_version  text NOT NULL,
  status           text NOT NULL,
  labels           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text NOT NULL
);
CREATE INDEX definitions_tenant_id_idx ON substrate.definitions (tenant_id);
CREATE INDEX definitions_kind_idx ON substrate.definitions (kind);
CREATE UNIQUE INDEX definitions_tenant_name_kind_uq ON substrate.definitions (tenant_id, name, kind);

CREATE TABLE substrate.definition_versions (
  definition_id    text NOT NULL REFERENCES substrate.definitions (definition_id),
  version          text NOT NULL,
  content_hash     text NOT NULL,
  family           text NOT NULL,
  status           text NOT NULL,
  body             jsonb NOT NULL,
  compiler_version text,
  diagnostics      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text NOT NULL,
  PRIMARY KEY (definition_id, version)
);
CREATE INDEX definition_versions_content_hash_idx ON substrate.definition_versions (content_hash);

CREATE TABLE substrate.compiled_plans (
  content_hash     text PRIMARY KEY,
  plan_id          text NOT NULL UNIQUE,
  definition_id    text NOT NULL REFERENCES substrate.definitions (definition_id),
  kind             text NOT NULL,
  version          text NOT NULL,
  compiler_version text NOT NULL,
  plan_body        jsonb NOT NULL,
  byte_size        integer NOT NULL,
  compiled_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compiled_plans_definition_id_idx ON substrate.compiled_plans (definition_id);
CREATE INDEX compiled_plans_kind_idx ON substrate.compiled_plans (kind);

CREATE TABLE substrate.validated_contracts (
  content_hash     text PRIMARY KEY,
  definition_id    text NOT NULL REFERENCES substrate.definitions (definition_id),
  kind             text NOT NULL,
  version          text NOT NULL,
  schema_ref       text NOT NULL,
  contract_body    jsonb NOT NULL,
  validated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX validated_contracts_definition_id_idx ON substrate.validated_contracts (definition_id);
CREATE INDEX validated_contracts_kind_idx ON substrate.validated_contracts (kind);

CREATE TABLE substrate.deployments (
  deployment_id             text PRIMARY KEY,
  tenant_id                 text NOT NULL,
  version                   text NOT NULL,
  status                    text NOT NULL,
  operator_registry_version text NOT NULL,
  notes                     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                text NOT NULL
);
CREATE UNIQUE INDEX deployments_tenant_version_uq ON substrate.deployments (tenant_id, version);
CREATE INDEX deployments_tenant_status_idx ON substrate.deployments (tenant_id, status);

CREATE TABLE substrate.deployment_members (
  deployment_id  text NOT NULL REFERENCES substrate.deployments (deployment_id),
  kind           text NOT NULL,
  seq            integer NOT NULL DEFAULT 0,
  definition_id  text NOT NULL,
  plan_id        text,
  version        text NOT NULL,
  content_hash   text NOT NULL,
  PRIMARY KEY (deployment_id, kind, seq)
);
CREATE INDEX deployment_members_content_hash_idx ON substrate.deployment_members (content_hash);

-- Request-time role privileges. platform_app owns nothing; the migrator/owner grants exactly what the
-- request path needs. No table here is append-only in this phase, so all get SELECT/INSERT/UPDATE.
GRANT USAGE ON SCHEMA substrate TO platform_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA substrate TO platform_app;
