-- The `capability` schema + provider_mappings: tenant-specific overrides of a capability's default
-- ProviderMapping (the default ships inside the content-hashed capability contract). Absence of a row =
-- use the contract default. Columns verbatim from database/table-catalog.md.
CREATE SCHEMA IF NOT EXISTS capability;

CREATE TABLE capability.provider_mappings (
  provider_mapping_id text PRIMARY KEY,
  tenant_id           text NOT NULL,
  capability_name     text NOT NULL,
  providers           jsonb NOT NULL,
  eligibility         jsonb NOT NULL DEFAULT '[]'::jsonb,
  on_no_provider      text NOT NULL DEFAULT 'fail',
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          text NOT NULL
);
CREATE UNIQUE INDEX pm_tenant_capability_uq ON capability.provider_mappings (tenant_id, capability_name);
ALTER TABLE capability.provider_mappings ADD CONSTRAINT pm_on_no_provider_ck
  CHECK (on_no_provider IN ('fail','handoff'));

GRANT USAGE ON SCHEMA capability TO platform_app;
GRANT SELECT, INSERT, UPDATE ON capability.provider_mappings TO platform_app;
