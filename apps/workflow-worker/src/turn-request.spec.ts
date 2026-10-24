// Turn-scoped durable identity: two agent-node visits in one workflow run must get DISTINCT turnIds
// (the second visit's tool executions were silently dropped by the unique (tenant_id, idempotency_key)
// index when both visits shared `trn_<correlationId>`), and every derived turnId must still satisfy
// the TurnId brand in @hermes-one/contracts.
import {describe, expect, it} from 'vitest';
import {TurnId, type PinnedRef, type Principal} from '@hermes-one/contracts';
import {buildAgentTurnRequest} from './turn-request.js';

const PIN = {deploymentId: 'dpl_spec', version: '1.0.0'};
const PRINCIPAL = {
  id: 'prn_spec',
  tenantId: 'tnt_spec',
  kind: 'customer',
  roles: [],
  scopes: [],
  attributes: {},
} as unknown as Principal;
const ENGINE = {
  definitionId: 'def_engine_spec',
  version: '1.0.0',
  contentHash: `sha256:${'a'.repeat(64)}`,
} as unknown as PinnedRef;

const build = (visitSeq: number, conversationId: string | null = 'cnv_spec') =>
  buildAgentTurnRequest(
    'tnt_spec',
    PIN,
    PRINCIPAL,
    ENGINE,
    'triage the caller',
    {intent: 'no-power'},
    'wf-triage-abc-123',
    conversationId,
    visitSeq,
    '2026-07-17T00:00:00.000Z',
  );

describe('buildAgentTurnRequest turn identity', () => {
  it('derives distinct turnIds for visit seq 0 and 1, both matching the TurnId brand', () => {
    const first = build(0);
    const second = build(1);
    expect(first.turnId).not.toBe(second.turnId);
    expect(() => TurnId.parse(first.turnId)).not.toThrow();
    expect(() => TurnId.parse(second.turnId)).not.toThrow();
  });

  it('is deterministic per (correlationId, visitSeq) — a Temporal replay re-derives the same turnId', () => {
    expect(build(0).turnId).toBe(build(0).turnId);
    expect(build(1).turnId).toBe(build(1).turnId);
  });
});

describe('buildAgentTurnRequest conversation identity', () => {
  it('carries the ingest-edge conversationId onto the workspace — a handoff turn persists its durable task row only with it', () => {
    expect(build(0).workspace.conversationId).toBe('cnv_spec');
  });

  it('keeps null for genuinely conversation-less starts', () => {
    expect(build(0, null).workspace.conversationId).toBeNull();
  });
});
