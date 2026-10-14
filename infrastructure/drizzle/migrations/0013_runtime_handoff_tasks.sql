-- Durable human-handoff task (ADR-012): the request + ownership state a turn writes when it hands off to
-- a human. Merges HandoffRequest + HandoffState into one row. Lifecycle
-- transitions (assign/takeover/resolve) are appended to `transitions` by the admin/temporal layers later.
CREATE TABLE runtime.handoff_tasks (
  handoff_id         text PRIMARY KEY,
  tenant_id          text NOT NULL,
  conversation_id    text NOT NULL,
  triggering_turn_id text,
  reason             text NOT NULL,
  priority           text NOT NULL,
  summary            text NOT NULL,
  evidence_snapshot  jsonb NOT NULL DEFAULT '[]'::jsonb,
  queue              text NOT NULL,
  operator_id        text,
  status             text NOT NULL,
  owner              text NOT NULL,
  transitions        jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_at       timestamptz NOT NULL,
  expires_at         timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ho_tenant_status_idx ON runtime.handoff_tasks (tenant_id, status);
CREATE INDEX ho_queue_status_idx ON runtime.handoff_tasks (queue, status);
CREATE INDEX ho_conversation_idx ON runtime.handoff_tasks (conversation_id);

ALTER TABLE runtime.handoff_tasks ADD CONSTRAINT handoff_tasks_reason_ck
  CHECK (reason IN ('policy-required','agent-uncertain','customer-requested','error-escalation','high-value'));
ALTER TABLE runtime.handoff_tasks ADD CONSTRAINT handoff_tasks_priority_ck
  CHECK (priority IN ('low','normal','high','urgent'));
ALTER TABLE runtime.handoff_tasks ADD CONSTRAINT handoff_tasks_status_ck
  CHECK (status IN ('requested','assigned','human_owned','resolved','returned','expired'));
ALTER TABLE runtime.handoff_tasks ADD CONSTRAINT handoff_tasks_owner_ck
  CHECK (owner IN ('agent','human'));

GRANT SELECT, INSERT, UPDATE ON runtime.handoff_tasks TO platform_app;
