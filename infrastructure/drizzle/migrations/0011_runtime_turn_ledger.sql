-- Durable turn persistence (Tier 2): the runtime.* ledger a completed agent turn writes — the tool-call
-- replay/audit record, its grounded evidence, and every policy gate decision. Tables + indexes + enum
-- checks + request-time grants; RLS is applied in 0012. Columns cover
-- runtime.tool_executions / evidence_records / policy_decisions.

CREATE TABLE runtime.tool_executions (
  tool_call_id     text PRIMARY KEY,
  tenant_id        text NOT NULL,
  turn_id          text NOT NULL,
  capability_name  text NOT NULL,
  input            jsonb NOT NULL,
  idempotency_key  text NOT NULL,
  ok               boolean NOT NULL,
  output           jsonb,
  side_effect      text NOT NULL,
  state_changed    boolean NOT NULL DEFAULT false,
  changed_domains  text[] NOT NULL DEFAULT '{}',
  metrics          jsonb NOT NULL,
  error            jsonb,
  proposed_at      timestamptz NOT NULL,
  executed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX te_tenant_turn_idx ON runtime.tool_executions (tenant_id, turn_id);
CREATE UNIQUE INDEX te_tenant_idempotency_uq ON runtime.tool_executions (tenant_id, idempotency_key);
ALTER TABLE runtime.tool_executions ADD CONSTRAINT tool_executions_side_effect_ck
  CHECK (side_effect IN ('none','read','write','external','payment'));

CREATE TABLE runtime.evidence_records (
  id               text PRIMARY KEY,
  tenant_id        text NOT NULL,
  turn_id          text NOT NULL,
  tool_call_id     text,
  kind             text NOT NULL,
  capability_name  text,
  statement        text NOT NULL,
  data             jsonb NOT NULL,
  source           text NOT NULL,
  trusted          boolean NOT NULL,
  observed_at      timestamptz NOT NULL
);
CREATE INDEX evd_tenant_turn_idx ON runtime.evidence_records (tenant_id, turn_id);
ALTER TABLE runtime.evidence_records ADD CONSTRAINT evidence_records_kind_ck
  CHECK (kind IN ('tool-output','authoritative-read','retrieval','system'));
ALTER TABLE runtime.evidence_records ADD CONSTRAINT evidence_records_source_ck
  CHECK (source IN ('authoritative','provider','retrieved','system'));

CREATE TABLE runtime.policy_decisions (
  decision_id      text PRIMARY KEY,
  tenant_id        text NOT NULL,
  turn_id          text,
  correlation_id   text NOT NULL,
  site             text NOT NULL,
  policy_rule_id   text NOT NULL,
  outcome          text NOT NULL,
  reason           text NOT NULL,
  detail           jsonb,
  capability_name  text,
  decided_at       timestamptz NOT NULL
);
CREATE INDEX pld_tenant_turn_idx ON runtime.policy_decisions (tenant_id, turn_id);
CREATE INDEX pld_tenant_decided_idx ON runtime.policy_decisions (tenant_id, decided_at);
ALTER TABLE runtime.policy_decisions ADD CONSTRAINT policy_decisions_site_ck
  CHECK (site IN ('voter','preGate','postGate'));
ALTER TABLE runtime.policy_decisions ADD CONSTRAINT policy_decisions_outcome_ck
  CHECK (outcome IN ('allow','deny','defer','repair','handoff','approval'));

-- Request-time role privileges (mirrors 0004; new tables need their own grant).
GRANT SELECT, INSERT, UPDATE ON runtime.tool_executions TO platform_app;
GRANT SELECT, INSERT, UPDATE ON runtime.evidence_records TO platform_app;
GRANT SELECT, INSERT, UPDATE ON runtime.policy_decisions TO platform_app;
