// @platform/contracts — src/handoff.ts
// Human-handoff contracts (ADR-012): HandoffRequest (durable request to move a conversation to a human)
// and HandoffState (auditable ownership lifecycle). Handoff is an explicit, durable workflow state, not
// a flag; resolution is a Temporal signal. The workflow/temporal signal wiring + admin inbox are separate
// packs — this is the shared contract.
import {z} from 'zod';
import {HandoffId, TenantId, ConversationId, PrincipalId, TurnId, IsoTimestamp} from './substrate.js';
import {EvidenceRecord} from './agent-runtime.js';

/* ------------------------------ Request -------------------------------- */

export const HandoffReason = z.enum([
  'policy-required', // policy outcome=handoff/approval
  'agent-uncertain', // agent could not ground a confident action
  'customer-requested', // customer asked for a human
  'error-escalation', // repeated tool/infra failure
  'high-value', // amount/risk over threshold
]);
export type HandoffReason = z.infer<typeof HandoffReason>;

export const HandoffPriority = z.enum(['low', 'normal', 'high', 'urgent']);
export type HandoffPriority = z.infer<typeof HandoffPriority>;

export const HandoffAssignmentTarget = z.object({
  /** Route to a queue (skill/team) and/or a specific operator. */
  queue: z.string().min(1),
  operatorId: PrincipalId.nullable(),
});
export type HandoffAssignmentTarget = z.infer<typeof HandoffAssignmentTarget>;

export const HandoffRequest = z.object({
  handoffId: HandoffId,
  tenantId: TenantId,
  conversationId: ConversationId,
  /** The turn that triggered the handoff (audit link). */
  triggeringTurnId: TurnId.nullable(),
  reason: HandoffReason,
  priority: HandoffPriority,
  /** Human-readable summary the operator sees first (grounded from evidence). */
  summary: z.string().min(1).max(2000),
  /** Grounded context snapshot — no re-derivation by the human. */
  evidenceSnapshot: z.array(EvidenceRecord).default([]),
  target: HandoffAssignmentTarget,
  requestedAt: IsoTimestamp,
  /** Wall-clock deadline after which the workflow onTimeout path runs. */
  expiresAt: IsoTimestamp.nullable(),
});
export type HandoffRequest = z.infer<typeof HandoffRequest>;

/* ------------------------------- State --------------------------------- */

export const HandoffStatus = z.enum([
  'requested',
  'assigned',
  'human_owned',
  'resolved',
  'returned',
  'expired',
]);
export type HandoffStatus = z.infer<typeof HandoffStatus>;

export const HandoffOwner = z.enum(['agent', 'human']);
export type HandoffOwner = z.infer<typeof HandoffOwner>;

export const HandoffState = z.object({
  handoffId: HandoffId,
  tenantId: TenantId,
  conversationId: ConversationId,
  status: HandoffStatus,
  owner: HandoffOwner,
  assignedOperatorId: PrincipalId.nullable(),
  /** Append-only transition log for audit. */
  transitions: z
    .array(
      z.object({
        from: HandoffStatus.nullable(),
        to: HandoffStatus,
        by: PrincipalId, // operator or system principal
        at: IsoTimestamp,
        note: z.string().max(1000).optional(),
      }),
    )
    .default([]),
  updatedAt: IsoTimestamp,
});
export type HandoffState = z.infer<typeof HandoffState>;

/* ---------------------------- Resolution ------------------------------- */

export const HandoffDisposition = z.enum(['completed', 'return-to-agent', 'closed-no-action', 'abandoned']);
export type HandoffDisposition = z.infer<typeof HandoffDisposition>;

/** The signal payload that resumes/terminates the parked workflow. */
export const HandoffResolution = z.object({
  handoffId: HandoffId,
  disposition: HandoffDisposition,
  resolvedBy: PrincipalId,
  /** Data handed back to the agent when returning (e.g. an instruction, a booked slot). */
  result: z.record(z.string(), z.unknown()).default({}),
  note: z.string().max(2000).optional(),
  resolvedAt: IsoTimestamp,
});
export type HandoffResolution = z.infer<typeof HandoffResolution>;

/* ---------------------------- Service port ----------------------------- */

export interface HandoffService {
  request(req: HandoffRequest): Promise<HandoffState>;
  assign(handoffId: HandoffId, operatorId: PrincipalId): Promise<HandoffState>;
  takeover(handoffId: HandoffId, operatorId: PrincipalId): Promise<HandoffState>;
  resolve(resolution: HandoffResolution): Promise<HandoffState>;
  get(handoffId: HandoffId): Promise<HandoffState | null>;
}

/** Temporal signal names (shared with temporal/ pack). */
export const HANDOFF_SIGNALS = {
  assigned: 'handoff.assigned',
  resolved: 'handoff.resolved',
} as const;
