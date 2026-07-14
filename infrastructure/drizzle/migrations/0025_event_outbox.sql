-- The `event` schema + event_outbox: transactional outbox for "commit-and-publish". An outbox row is
-- written in the SAME transaction as the domain row it fans out from; a publisher polls status='pending'
-- and dispatches, then marks 'published'. Columns verbatim from database/table-catalog.md.
CREATE SCHEMA IF NOT EXISTS event;

CREATE TABLE event.event_outbox (
  outbox_id      text PRIMARY KEY,
  sequence       bigserial NOT NULL,                             -- ordered poll cursor
  tenant_id      text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   text NOT NULL,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz
);
CREATE UNIQUE INDEX eo_sequence_uq ON event.event_outbox (sequence);
CREATE INDEX eo_tenant_idx ON event.event_outbox (tenant_id);
-- Publisher poll index: pending rows in sequence order.
CREATE INDEX eo_pending_seq_idx ON event.event_outbox (sequence) WHERE status = 'pending';
ALTER TABLE event.event_outbox ADD CONSTRAINT eo_status_ck CHECK (status IN ('pending','published','failed'));

GRANT USAGE ON SCHEMA event TO platform_app;
-- bigserial needs the sequence usable by the writer role.
GRANT USAGE, SELECT ON SEQUENCE event.event_outbox_sequence_seq TO platform_app;
GRANT SELECT, INSERT, UPDATE ON event.event_outbox TO platform_app;
