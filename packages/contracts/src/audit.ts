// @platform/contracts — src/audit.ts
// Audit + usage-metering contracts.
// AuditEvent is the append-only, immutable, tamper-evident record of every material action (integrityHash =
// content hash of the row minus id). UsageEvent/UsageRecord carry principalId + a dedupeKey so at-least-once
// emission (Temporal retries / actor replays) can't double-count into billing (findings T7). Metering has one
// source of truth per signal (agentback stream for tokens/cost, OTel spans, Temporal history) — this is the
// aggregation shape, not a parallel counter.
// NOTE: ChangedDomain is not imported (unused by these types); omitted to satisfy
// noUnusedLocals. z.record uses the codebase's 2-arg form (zod version).
import {z} from 'zod';
import {
  AuditEventId,
  UsageEventId,
  TenantId,
  PrincipalId,
  TurnId,
  ConversationId,
  IsoTimestamp,
} from './substrate.js';
import {CapabilityName} from './capability.js';

/* ------------------------------ AuditEvent ----------------------------- */

export const AuditAction = z.enum([
  'tool.invoked',
  'tool.denied',
  'message.sent',
  'message.received',
  'decision.rule',
  'decision.policy',
  'handoff.requested',
  'handoff.resolved',
  'deployment.published',
  'definition.published',
  'tenant.config.changed',
]);
export type AuditAction = z.infer<typeof AuditAction>;

/** Append-only, immutable. One row per material action. */
export const AuditEvent = z.object({
  id: AuditEventId,
  tenantId: TenantId,
  principalId: PrincipalId, // WHO — always present (T7)
  action: AuditAction,
  /** Causal chain — correlationId = turnId at turn scope. */
  correlationId: z.string().min(1),
  turnId: TurnId.nullable(),
  conversationId: ConversationId.nullable(),
  /** Subject of the action (capability name, definitionId, handoffId, …). */
  subject: z.string().min(1),
  /** Structured, PII-minimized detail. */
  detail: z.record(z.string(), z.unknown()).default({}),
  outcome: z.enum(['success', 'denied', 'error']),
  occurredAt: IsoTimestamp,
  /** Content hash of (this row minus id) — tamper-evidence + dedupe on replay. */
  integrityHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/* ------------------------------ Usage ---------------------------------- */

export const MeterKind = z.enum([
  'model.input.tokens',
  'model.output.tokens',
  'model.cost.usd',
  'tool.invocation',
  'message.sent',
  'storage.vector',
]);
export type MeterKind = z.infer<typeof MeterKind>;

/**
 * Raw metering event — emitted AT-LEAST-ONCE. The dedupeKey is what makes billing idempotent (T7).
 * Sourced from agentback's metering stream for token/cost kinds (single source of truth).
 */
export const UsageEvent = z.object({
  id: UsageEventId,
  tenantId: TenantId,
  principalId: PrincipalId, // WHO consumed — was missing before (T7)
  meterKind: MeterKind,
  quantity: z.number().nonnegative(),
  unit: z.enum(['tokens', 'usd', 'count', 'bytes']),
  /** correlationId = turnId; ties usage to the audit chain and agentback correlationId. */
  correlationId: z.string().min(1),
  turnId: TurnId.nullable(),
  capability: CapabilityName.nullable(),
  /**
   * Idempotency key: hash(principalId, correlationId, meterKind, sequenceWithinCorrelation).
   * Identical across Temporal retries / actor replays → collapses to one UsageRecord.
   */
  dedupeKey: z.string().min(1),
  emittedAt: IsoTimestamp,
});
export type UsageEvent = z.infer<typeof UsageEvent>;

/** Deduped, billable aggregate. Upserted ON CONFLICT(dedupeKey) DO NOTHING. */
export const UsageRecord = z.object({
  dedupeKey: z.string().min(1), // PRIMARY KEY — enforces exactly-once billing
  tenantId: TenantId,
  principalId: PrincipalId,
  meterKind: MeterKind,
  quantity: z.number().nonnegative(),
  unit: z.enum(['tokens', 'usd', 'count', 'bytes']),
  correlationId: z.string().min(1),
  turnId: TurnId.nullable(),
  /** Billing period bucket (e.g. "2026-07"). */
  period: z.string().regex(/^\d{4}-\d{2}$/),
  recordedAt: IsoTimestamp,
});
export type UsageRecord = z.infer<typeof UsageRecord>;

/* ---------------------------- Ports ------------------------------------ */

export interface AuditSink {
  /** Append-only; throws if `id`/`integrityHash` already exists (idempotent on replay). */
  append(event: AuditEvent): Promise<void>;
  query(filter: {tenantId: TenantId; correlationId?: string; action?: AuditAction}): Promise<AuditEvent[]>;
}

export interface UsageMeter {
  /** Idempotent: same dedupeKey is a no-op. Aggregates agentback's stream, does not re-derive it. */
  record(event: UsageEvent): Promise<{inserted: boolean}>;
  summarize(tenantId: TenantId, period: string): Promise<Record<MeterKind, number>>;
}

/** Helper: canonical dedupe-key derivation. */
export function deriveDedupeKey(input: {
  principalId: PrincipalId;
  correlationId: string;
  meterKind: MeterKind;
  sequence: number;
}): string {
  return `${input.principalId}:${input.correlationId}:${input.meterKind}:${input.sequence}`;
}
