// Turn-scoped durable identity for the deterministic rail: the decision.rule audit id must cover the
// per-run VISIT sequence. Without it a plan revisiting the same rule node with the same outcome reused
// the id while the integrityHash (which covers occurredAt — the workflow clock, different per visit)
// differed → the append-only sink tamper-rejected (409, non-retryable) and killed the run.
import {describe, expect, it} from 'vitest';
import type {AuditEvent} from '@platform/contracts';
import type {DrizzleAuditSink} from '@platform-internal/drizzle';
import {createDecisionActivities, type EmitDecisionRuleArgs} from './decision-activities.js';

function capture() {
  const events: AuditEvent[] = [];
  const sink = {append: async (e: AuditEvent) => void events.push(e)} as unknown as DrizzleAuditSink;
  return {events, activities: createDecisionActivities(sink)};
}

const BASE: EmitDecisionRuleArgs = {
  tenantId: 'tnt_spec',
  correlationId: 'wf-triage-abc-123',
  outcome: 'eligible',
  rulePlanId: 'pln_triage_spec',
  occurredAt: '2026-07-17T00:00:00.000Z',
  visitSeq: 0,
};

describe('emitDecisionRule audit identity', () => {
  it('same visit seq re-derives the identical id AND integrityHash (workflow replay collapses)', async () => {
    const {events, activities} = capture();
    await activities.emitDecisionRule(BASE);
    await activities.emitDecisionRule(BASE);
    expect(events[0].id).toMatch(/^aud_[0-9a-f]{24}$/);
    expect(events[1].id).toBe(events[0].id);
    expect(events[1].integrityHash).toBe(events[0].integrityHash);
  });

  it('a second visit of the same rule node with the same outcome gets a DISTINCT id', async () => {
    const {events, activities} = capture();
    await activities.emitDecisionRule(BASE);
    // Second visit: same rule, same outcome — only the visit seq and workflow clock advance.
    await activities.emitDecisionRule({...BASE, visitSeq: 1, occurredAt: '2026-07-17T00:00:01.000Z'});
    expect(events[1].id).not.toBe(events[0].id);
    // The hash still covers occurredAt (tamper-evidence unchanged).
    expect(events[1].integrityHash).not.toBe(events[0].integrityHash);
  });
});
