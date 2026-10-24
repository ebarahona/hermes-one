// Derive billable UsageEvents from a completed turn's usage totals — an edge concern.
// One event per metered signal: model input/output tokens, model cost, and tool-invocation count. Each
// dedupeKey (principalId:turnId:meterKind:sequence — the audit contract pins "correlationId = turnId"
// at turn scope, and this build's workflow correlationId spans EVERY turn in a run) is stable across
// Temporal retries so re-emission collapses to exactly-once billing (T7), while a second turn in the
// same run gets its own keys instead of being deduped away unbilled. id is deterministic over the
// dedupeKey (replay-safe).
//
// FLAGGED (DEFERRED-AND-FLAGGED AU1): the single source of truth for tokens/cost is agentback's metering
// stream (T7). This build meters the turn's self-reported usage totals as an interim placeholder until that
// stream is wired. message.sent / storage.vector meters belong to the channel / vector layers.
import {createHash} from 'node:crypto';
import {
  deriveDedupeKey,
  type MeterKind,
  type UsageEvent,
} from '@hermes-one/contracts';
import type {TurnLedger} from '@hermes-one/agent-runtime';

interface MeterInput {
  principalId: UsageEvent['principalId'];
  occurredAt: UsageEvent['emittedAt'];
}

export function deriveUsageEvents(
  ledger: TurnLedger,
  ctx: MeterInput,
): UsageEvent[] {
  const meters: {
    kind: MeterKind;
    quantity: number;
    unit: UsageEvent['unit'];
  }[] = [
    {
      kind: 'model.input.tokens',
      quantity: ledger.usage.inputTokens,
      unit: 'tokens',
    },
    {
      kind: 'model.output.tokens',
      quantity: ledger.usage.outputTokens,
      unit: 'tokens',
    },
    {kind: 'model.cost.usd', quantity: ledger.usage.modelCostUsd, unit: 'usd'},
    {kind: 'tool.invocation', quantity: ledger.usage.toolCount, unit: 'count'},
  ];

  return meters.map(m => {
    const dedupeKey = deriveDedupeKey({
      // The dedupe recipe's correlation component is the TURN ("correlationId =
      // turnId") — keying on the workflow-wide correlationId made every turn after the first collapse
      // into the first turn's records (never billed).
      correlationId: ledger.turnId,
      principalId: ctx.principalId,
      meterKind: m.kind,
      sequence: 0, // one aggregate per (turn, meterKind)
    });
    const id =
      `usg_${createHash('sha256').update(dedupeKey).digest('hex').slice(0, 24)}` as UsageEvent['id'];
    return {
      id,
      tenantId: ledger.tenantId as UsageEvent['tenantId'],
      principalId: ctx.principalId,
      meterKind: m.kind,
      quantity: m.quantity,
      unit: m.unit,
      correlationId: ledger.correlationId,
      turnId: ledger.turnId as UsageEvent['turnId'],
      capability: null,
      dedupeKey,
      emittedAt: ctx.occurredAt,
    };
  });
}
