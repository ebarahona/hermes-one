// Evidence-only composition (ADR-009): the composer may cite ONLY the turn's accumulated evidence,
// never facts the model invented. Grounded evidence statements become the reply; when there is no
// evidence (a purely conversational turn with no tool calls) it falls back to the model's final text,
// which by construction asserts no un-grounded facts. Retrieved/provider evidence is untrusted input.
import type {TurnContext} from '@platform/contracts';

/**
 * `repairInstruction` is passed on a bounded post-gate repair (ADR-019): re-compose the reply to
 * satisfy the policy's instruction while keeping the grounding. A model-backed composer honors it; the
 * default evidence-only composer cannot (it may only restate grounded evidence, never reshape it), so
 * a repair against the default composer yields the same draft and the loop escalates to a human —
 * the safe outcome, since a reply a policy flagged for repair is never delivered unrepaired.
 */
export type Composer = (
  ctx: TurnContext,
  objective: string,
  fallbackText?: string,
  repairInstruction?: string,
) => string;

/** The default evidence-only composer: summarize grounded evidence statements, else the model's text. */
export const composeEvidenceOnly: Composer = (ctx, _objective, fallbackText) => {
  const grounded = ctx.evidence.filter(e => e.trusted).map(e => e.statement.trim()).filter(Boolean);
  if (grounded.length > 0) return grounded.join(' ');
  return (fallbackText ?? '').trim();
};
