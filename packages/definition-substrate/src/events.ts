// Substrate lifecycle audit events (domain events): `definition.published` (fires for
// kind:'capability' definitions — the schema's own trigger column) and `deployment.published`
// (DeploymentService.publish). Both are OUTBOX-BACKED with aggregate.type 'audit_event': the audit
// row IS the domain event, and the write port commits row + audit + outbox in ONE transaction
// (commit-and-publish — the same F3 rule persistTurnAtomic enforces for turns).
//
// Identity recipe: the id is deterministic over the event's addressing PLUS its
// occurredAt — an audit event records an ACT, and two publishes of the same def@version at different
// times are two acts (two rows), while a true replay (same stamped clock, e.g. a retried transaction)
// re-derives the identical event and collapses. Deriving the id WITHOUT the timestamp made a
// legitimate re-publish look like tampering to the audit sink's tamper-reject — caught live by that
// very guard. integrityHash is sha256 over the row minus id — the SAME canonical material the agent
// plane (audit-events.ts) and edge decision activities (decision-activities.ts) transcribe.
// correlationId is the OPERATION's durable id (deploymentId / definitionId@version), so
// composeTimeline("what happened to deployment X?") queries it directly.
import {createHash} from 'node:crypto';
import type {
  AuditEvent,
  IsoTimestamp,
  PrincipalId,
  TenantId,
} from '@hermes-one/contracts';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

function auditIdentity(
  row: Omit<AuditEvent, 'id' | 'integrityHash'>,
): AuditEvent {
  const canonical = JSON.stringify([
    row.tenantId,
    row.principalId,
    row.action,
    row.correlationId,
    row.turnId,
    row.conversationId,
    row.subject,
    row.detail,
    row.outcome,
    row.occurredAt,
  ]);
  const id = `aud_${sha256hex(`${row.correlationId}:${row.action}:${row.subject}:${row.occurredAt}`).slice(0, 24)}`;
  return {
    ...row,
    id,
    integrityHash: `sha256:${sha256hex(canonical)}`,
  } as AuditEvent;
}

export function definitionPublishedEvent(args: {
  tenantId: TenantId;
  actor: PrincipalId;
  definitionId: string;
  name: string;
  version: string;
  contentHash: string;
  occurredAt: IsoTimestamp;
}): AuditEvent {
  return auditIdentity({
    tenantId: args.tenantId,
    principalId: args.actor,
    action: 'definition.published',
    correlationId: `${args.definitionId}@${args.version}`,
    turnId: null,
    conversationId: null,
    subject: args.name, // the capability NAME — the payload is the CapabilityContract summary
    detail: {
      definitionId: args.definitionId,
      version: args.version,
      contentHash: args.contentHash,
    },
    outcome: 'success',
    occurredAt: args.occurredAt,
  } as Omit<AuditEvent, 'id' | 'integrityHash'>);
}

export function deploymentPublishedEvent(args: {
  tenantId: TenantId;
  actor: PrincipalId;
  deploymentId: string;
  version: string;
  operatorRegistryVersion: string;
  memberCount: number;
  occurredAt: IsoTimestamp;
}): AuditEvent {
  return auditIdentity({
    tenantId: args.tenantId,
    principalId: args.actor,
    action: 'deployment.published',
    correlationId: args.deploymentId,
    turnId: null,
    conversationId: null,
    subject: args.deploymentId,
    detail: {
      version: args.version,
      operatorRegistryVersion: args.operatorRegistryVersion,
      memberCount: args.memberCount,
    },
    outcome: 'success',
    occurredAt: args.occurredAt,
  } as Omit<AuditEvent, 'id' | 'integrityHash'>);
}
