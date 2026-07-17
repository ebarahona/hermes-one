-- capability.provider_credentials: one tenant's ENVELOPE-ENCRYPTED credential set for one provider
-- serving one capability (ADR-026). Tenant vendor credentials are rows, NOT cloud-secret-manager
-- entries: per-secret pricing/quotas are O(tenants × providers) on the dispatch hot path, while rows
-- cost storage, cache the unwrap, and rotate as an UPDATE. The `ciphertext` is the encrypted JSON
-- bundle; `key_ref` names the wrapping key (local:<id> in dev, a KMS CMK ref in prod) — plaintext
-- credentials NEVER touch a column. Amends database/table-catalog.md (flagged there by
-- security/secrets-and-key-management.md's own Open Questions as the registry-sync item).
CREATE TABLE capability.provider_credentials (
  credential_id text PRIMARY KEY,
  tenant_id     text NOT NULL,
  provider_id   text NOT NULL,
  capability    text NOT NULL,
  ciphertext    text NOT NULL,
  key_ref       text NOT NULL,
  status        text NOT NULL DEFAULT 'active',
  rotated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pc_tenant_provider_capability_uq
  ON capability.provider_credentials (tenant_id, provider_id, capability);
ALTER TABLE capability.provider_credentials ADD CONSTRAINT pc_status_ck
  CHECK (status IN ('active','rotating','revoked'));
ALTER TABLE capability.provider_credentials ADD CONSTRAINT pc_credential_id_ck
  CHECK (credential_id LIKE 'pvc_%');

GRANT SELECT, INSERT, UPDATE ON capability.provider_credentials TO platform_app;

-- Strict tenant isolation: a tenant reads/writes ONLY its own credential rows.
ALTER TABLE capability.provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE capability.provider_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_credentials_tenant_isolation ON capability.provider_credentials
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
