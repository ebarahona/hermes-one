// Tenant-scoped writer for the durable turn ledger (runtime.tool_executions / evidence_records /
// policy_decisions, RLS 'strict'). A completed agent turn hands its ledger here; all three record sets
// are written in ONE transaction under the pinned tenant GUC, idempotently (ON CONFLICT DO NOTHING on
// each PK) so a Temporal activity retry that replays the turn collapses to the same rows. All access
// goes through withTenant → set_config('app.tenant_id').
import type {TenantId, TenantScope} from '@hermes-one/contracts';
import {
  TenantAwareRepository,
  type PlatformTx,
} from './tenant-aware.repository.js';
import {
  toolExecutions,
  evidenceRecords,
  policyDecisions,
} from './schema/runtime.schema.js';

export interface ToolExecutionRow {
  toolCallId: string;
  turnId: string;
  capabilityName: string;
  input: unknown;
  idempotencyKey: string;
  ok: boolean;
  output?: unknown;
  sideEffect: 'none' | 'read' | 'write' | 'external' | 'payment';
  stateChanged: boolean;
  changedDomains: string[];
  metrics: unknown;
  error?: unknown;
  proposedAt: Date;
  executedAt?: Date;
}

export interface EvidenceRow {
  id: string;
  turnId: string;
  toolCallId?: string;
  kind: 'tool-output' | 'authoritative-read' | 'retrieval' | 'system';
  capabilityName?: string;
  statement: string;
  data: unknown;
  source: 'authoritative' | 'provider' | 'retrieved' | 'system';
  trusted: boolean;
  observedAt: Date;
}

export interface PolicyDecisionRow {
  decisionId: string;
  turnId?: string;
  correlationId: string;
  site: 'voter' | 'preGate' | 'postGate';
  policyRuleId: string;
  outcome: 'allow' | 'deny' | 'defer' | 'repair' | 'handoff' | 'approval';
  reason: string;
  detail?: unknown;
  capabilityName?: string;
  decidedAt: Date;
}

export interface TurnLedgerRows {
  toolExecutions: ToolExecutionRow[];
  evidence: EvidenceRow[];
  policyDecisions: PolicyDecisionRow[];
}

/**
 * Tx-scoped write core: insert all three record sets inside the CALLER's open tenant transaction.
 * Shared by `DrizzleTurnLedgerRepository.persistTurn` and the atomic `DrizzleTurnPersistence` writer
 * (turn-persistence.ts) so both paths are one implementation.
 */
export async function insertTurnLedger(
  tx: PlatformTx,
  tenantId: TenantId,
  rows: TurnLedgerRows,
): Promise<void> {
  // Dedup within the batch by idempotency key (and PK): two rows sharing a key would self-conflict in a
  // single INSERT even with ON CONFLICT DO NOTHING (it only checks pre-existing rows). Keep the first.
  const seenIdem = new Set<string>();
  const seenPk = new Set<string>();
  const dedupedExecs = rows.toolExecutions.filter(r => {
    if (seenIdem.has(r.idempotencyKey) || seenPk.has(r.toolCallId))
      return false;
    seenIdem.add(r.idempotencyKey);
    seenPk.add(r.toolCallId);
    return true;
  });

  if (dedupedExecs.length > 0) {
    await tx
      .insert(toolExecutions)
      .values(
        dedupedExecs.map(r => ({
          toolCallId: r.toolCallId,
          tenantId,
          turnId: r.turnId,
          capabilityName: r.capabilityName,
          input: r.input,
          idempotencyKey: r.idempotencyKey,
          ok: r.ok,
          output: r.output,
          sideEffect: r.sideEffect,
          stateChanged: r.stateChanged,
          changedDomains: r.changedDomains,
          metrics: r.metrics,
          error: r.error,
          proposedAt: r.proposedAt,
          ...(r.executedAt ? {executedAt: r.executedAt} : {}),
        })),
      )
      // No target: collapse on EITHER unique constraint — the tool_call_id PK OR the
      // (tenant_id, idempotency_key) unique index (a retried tool call = same logical op, per the
      // schema's per-tenant idempotency dedup). Targeting only the PK would let an idempotency-key
      // conflict throw (23505) and fail the activity.
      .onConflictDoNothing();
  }
  if (rows.evidence.length > 0) {
    await tx
      .insert(evidenceRecords)
      .values(
        rows.evidence.map(r => ({
          id: r.id,
          tenantId,
          turnId: r.turnId,
          toolCallId: r.toolCallId,
          kind: r.kind,
          capabilityName: r.capabilityName,
          statement: r.statement,
          data: r.data,
          source: r.source,
          trusted: r.trusted,
          observedAt: r.observedAt,
        })),
      )
      .onConflictDoNothing({target: evidenceRecords.id});
  }
  if (rows.policyDecisions.length > 0) {
    await tx
      .insert(policyDecisions)
      .values(
        rows.policyDecisions.map(r => ({
          decisionId: r.decisionId,
          tenantId,
          turnId: r.turnId,
          correlationId: r.correlationId,
          site: r.site,
          policyRuleId: r.policyRuleId,
          outcome: r.outcome,
          reason: r.reason,
          detail: r.detail,
          capabilityName: r.capabilityName,
          decidedAt: r.decidedAt,
        })),
      )
      .onConflictDoNothing({target: policyDecisions.decisionId});
  }
}

export class DrizzleTurnLedgerRepository extends TenantAwareRepository {
  /** Persist a completed turn's ledger for a tenant. Idempotent — a replayed turn collapses. */
  async persistTurn(rows: TurnLedgerRows, scope: TenantScope): Promise<void> {
    await this.withTenant(scope, tx =>
      insertTurnLedger(tx, scope.tenantId, rows),
    );
  }
}
