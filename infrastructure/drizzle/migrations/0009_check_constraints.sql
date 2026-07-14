-- Enum-shaped text columns pinned at the database, not just at the Zod boundary. (constraints.md)
ALTER TABLE substrate.definitions ADD CONSTRAINT definitions_kind_ck
  CHECK (kind IN ('workflow','rule','policy','capability','agent-engine'));
ALTER TABLE substrate.definitions ADD CONSTRAINT definitions_status_ck
  CHECK (status IN ('draft','validated','compiled','published','deployed','retired'));

ALTER TABLE substrate.deployments ADD CONSTRAINT deployments_status_ck
  CHECK (status IN ('active','superseded','rolledback'));

ALTER TABLE runtime.conversations ADD CONSTRAINT conversations_status_ck
  CHECK (status IN ('active','handoff','closed'));

ALTER TABLE runtime.messages ADD CONSTRAINT messages_direction_ck
  CHECK (direction IN ('inbound','outbound'));
ALTER TABLE runtime.messages ADD CONSTRAINT messages_status_ck
  CHECK (status IN ('received','queued','sent','delivered','read','failed','undelivered'));
