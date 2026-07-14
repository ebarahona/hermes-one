-- audit.usage_records: the deduped, billable usage aggregate. dedupe_key is the PRIMARY KEY — it enforces
-- exactly-once billing under at-least-once emission (Temporal retries / actor replays), findings T7.
-- Columns verbatim from database/table-catalog.md.
CREATE TABLE audit.usage_records (
  dedupe_key      text PRIMARY KEY,
  tenant_id       text NOT NULL,
  principal_id    text NOT NULL,
  meter_kind      text NOT NULL,
  quantity        numeric NOT NULL,
  unit            text NOT NULL,
  correlation_id  text NOT NULL,
  turn_id         text,
  period          text NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ur_tenant_period_meter_idx ON audit.usage_records (tenant_id, period, meter_kind);

ALTER TABLE audit.usage_records ADD CONSTRAINT usage_records_meter_kind_ck
  CHECK (meter_kind IN ('model.input.tokens','model.output.tokens','model.cost.usd','tool.invocation',
                        'message.sent','storage.vector'));
ALTER TABLE audit.usage_records ADD CONSTRAINT usage_records_unit_ck
  CHECK (unit IN ('tokens','usd','count','bytes'));
ALTER TABLE audit.usage_records ADD CONSTRAINT usage_records_period_ck
  CHECK (period ~ '^\d{4}-\d{2}$');

-- Request-time role privileges. SELECT + INSERT (records are upserted, never updated/deleted at runtime).
GRANT SELECT, INSERT ON audit.usage_records TO platform_app;
