// @platform/contracts — src/audit-replay.ts
// The READ side of the audit trail (observability/audit-and-replay.md): the composed incident timeline
// (audit_events ⋈ tool_executions ⋈ policy_decisions ⋈ evidence_records by tenant+correlation) + the two
// replay modes. Transcribed VERBATIM from the spec.
// NOTE: the spec imports WorkflowId from substrate, but no such brand exists there yet — the (deferred)
// ReplayService/SimulationService interfaces below type workflowId as `string` and flag the gap. Only
// AuditTimelineEntry/AuditQueryService are implemented in this build; replay/simulation need Temporal
// replay + mock-provider workers (deferred, see docs/DEFERRED-AND-FLAGGED.md).
import {z} from 'zod';
import {TurnId, IsoTimestamp, TenantId} from './substrate.js';
import {AuditEvent, type AuditAction} from './audit.js';
import {PolicyDecision} from './policy.js';
import {EvidenceRecord, ToolResult} from './agent-runtime.js';

/* --------------------------- Composed timeline -------------------------- */

export const AuditTimelineEntryKind = z.enum([
  'audit', 'tool-execution', 'policy-decision', 'evidence', 'tombstone',
]);
export type AuditTimelineEntryKind = z.infer<typeof AuditTimelineEntryKind>;

/** One row of the composed incident timeline. `detail` is `null` when the source row was crypto-shredded. */
export const AuditTimelineEntry = z.object({
  kind: AuditTimelineEntryKind,
  occurredAt: IsoTimestamp,
  correlationId: z.string().min(1),
  turnId: TurnId.nullable(),
  /** The underlying typed row, when decryptable; null for a 'tombstone' entry. */
  detail: z.union([AuditEvent, PolicyDecision, EvidenceRecord, ToolResult]).nullable(),
  /** Present only when kind='tombstone' (data-retention-jobs.md crypto-shred). */
  tombstoneReason: z.enum(['crypto-shredded', 'retention-purged']).optional(),
});
export type AuditTimelineEntry = z.infer<typeof AuditTimelineEntry>;

export interface AuditQueryService {
  /** Read-only join across audit_events/tool_executions/policy_decisions/evidence_records. */
  composeTimeline(tenantId: TenantId, correlationId: string): Promise<AuditTimelineEntry[]>;
  /** Filtered variant for the audit_events-only view (compliance export). */
  queryAuditEvents(tenantId: TenantId, filter: {correlationId?: string; action?: AuditAction}): Promise<AuditEvent[]>;
}

/* -------------------------------- Replay --------------------------------- */
// DEFERRED impl: needs Temporal history replay + a mock-provider simulation worker (audit-and-replay.md).

export const ReplayMode = z.enum(['history-only', 'simulation']);
export type ReplayMode = z.infer<typeof ReplayMode>;

export interface WorkflowStateSnapshot {
  readonly workflowId: string; // spec: WorkflowId brand (not yet in substrate) — flagged
  readonly runId: string;
  readonly currentNodeId: string | null;
  readonly dirtyDomains: string[];
  readonly reconstructedAt: IsoTimestamp;
}

/** Read-only. Never executes an activity function — replays recorded ActivityTaskCompleted results
 *  (worker-versioning-and-replay.md). A NonDeterminismError is surfaced, never swallowed. */
export interface ReplayService {
  replayWorkflow(workflowId: string, runId: string): Promise<WorkflowStateSnapshot>;
}

export const SimulationOverrides = z.object({
  dryRun: z.literal(true), // compiler-enforced; refuses to run without this
  mockProviderSet: z.string().min(1).default('default'),
  fromNodeId: z.string().optional(), // replay-from-point; omitted = from entry
});
export type SimulationOverrides = z.infer<typeof SimulationOverrides>;

/** Opt-in only. Runs REAL interpreter + REAL capability code against MOCK providers — never live ones.
 *  Every AuditEvent/UsageEvent emitted during a simulation carries detail.dryRun = true. */
export interface SimulationService {
  simulateWorkflow(
    workflowId: string,
    input: Record<string, unknown>,
    overrides: SimulationOverrides,
  ): Promise<{turnResults: unknown[]; toolResults: ToolResult[]}>;
}
