// Evidence-only composition (ADR-009): the composer may cite ONLY the turn's accumulated evidence,
// never facts the model invented. Grounded evidence statements become the reply; when there is no
// evidence (a purely conversational turn with no tool calls) it falls back to the model's final text,
// which by construction asserts no un-grounded facts. Retrieved/provider evidence is untrusted input.
import type {TurnContext} from '@platform/contracts';

export type Composer = (ctx: TurnContext, objective: string, fallbackText?: string) => string;

/** The default evidence-only composer: summarize grounded evidence statements, else the model's text. */
export const composeEvidenceOnly: Composer = (ctx, _objective, fallbackText) => {
  const grounded = ctx.evidence.filter(e => e.trusted).map(e => e.statement.trim()).filter(Boolean);
  if (grounded.length > 0) return grounded.join(' ');
  return (fallbackText ?? '').trim();
};
