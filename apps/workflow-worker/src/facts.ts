// Pure fact gathering for rule nodes (ADR-014): bundled into the deterministic workflow sandbox, so it
// does no I/O and depends only on its arguments.
import type {RuleFacts} from '@hermes-one/contracts';

/**
 * Read a `$input` binding from the run input. A path without a dot, or one naming an existing
 * top-level key, reads that key directly; otherwise it walks own properties segment by segment
 * (`meta.answered`), yielding `undefined` on the first missing segment.
 */
export function readInputPath(
  input: Record<string, unknown>,
  path: string,
): unknown {
  if (!path.includes('.') || Object.hasOwn(input, path)) return input[path];
  let cur: unknown = input;
  for (const segment of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, segment))
      return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/** Resolve a rule node's fact spec: `{$input: path}` → run input; anything else is a literal. */
export function gatherFacts(
  spec: Record<string, unknown>,
  input: Record<string, unknown>,
): RuleFacts {
  const facts: RuleFacts = {};
  for (const [k, v] of Object.entries(spec)) {
    facts[k] =
      v && typeof v === 'object' && '$input' in v
        ? readInputPath(input, (v as {$input: string}).$input)
        : v;
  }
  return facts;
}
