-- The `audit` schema + audit_events: the append-only, immutable, tamper-evident record of every material
-- action (ADR-009/012). integrity_hash = sha256 of the row (minus id) — dedupe on replay + tamper-evidence.
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE audit.audit_events (
  id               text PRIMARY KEY,
  tenant_id        text NOT NULL,
  principal_id     text NOT NULL,
  action           text NOT NULL,
  correlation_id   text NOT NULL,
  turn_id          text,
  conversation_id  text,
  subject          text NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome          text NOT NULL,
  occurred_at      timestamptz NOT NULL,
  integrity_hash   text NOT NULL
);
CREATE INDEX ae_tenant_correlation_idx ON audit.audit_events (tenant_id, correlation_id);
CREATE INDEX ae_tenant_occurred_idx ON audit.audit_events (tenant_id, occurred_at);
CREATE INDEX ae_tenant_action_idx ON audit.audit_events (tenant_id, action);

ALTER TABLE audit.audit_events ADD CONSTRAINT audit_events_action_ck
  CHECK (action IN ('tool.invoked','tool.denied','message.sent','message.received','decision.rule',
                    'decision.policy','handoff.requested','handoff.resolved','deployment.published',
                    'definition.published','tenant.config.changed'));
ALTER TABLE audit.audit_events ADD CONSTRAINT audit_events_outcome_ck
  CHECK (outcome IN ('success','denied','error'));

-- Request-time role privileges. Append-only: INSERT + SELECT, NO UPDATE/DELETE (immutability at the grant
-- level, on top of RLS). The migrator owns the schema.
GRANT USAGE ON SCHEMA audit TO platform_app;
GRANT SELECT, INSERT ON audit.audit_events TO platform_app;
