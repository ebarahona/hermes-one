// FieldRedactor: applies RedactionRule[] to a LogRecord's `fields` by dot-path BEFORE export, so PII is
// never logged raw. Strategies: mask (→ '[REDACTED]'), hash (→ 'sha256:<12hex>'
// — correlatable without exposing the value), drop (remove the field). Non-mutating: returns a new record.
//
// FLAGGED: the canonical rule SOURCE is the PiiCipher dataClass tagging
// (not yet built) — the rules passed here are a stand-in until that classification exists.
import {createHash} from 'node:crypto';
import type {LogRecord, RedactionRule, Redactor} from '@platform/contracts';

const sha256short = (s: string) =>
  createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Immutably apply a strategy at `path` within `obj`; no-op if the path is absent. */
function applyAtPath(
  obj: Record<string, unknown>,
  path: string[],
  strategy: RedactionRule['strategy'],
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (!(head in obj)) return obj;
  const clone = {...obj};
  if (rest.length === 0) {
    if (strategy === 'drop') {
      delete clone[head];
    } else if (strategy === 'mask') {
      clone[head] = '[REDACTED]';
    } else {
      clone[head] = `sha256:${sha256short(String(clone[head]))}`;
    }
    return clone;
  }
  const child = clone[head];
  if (child && typeof child === 'object' && !Array.isArray(child)) {
    clone[head] = applyAtPath(child as Record<string, unknown>, rest, strategy);
  }
  return clone;
}

export class FieldRedactor implements Redactor {
  constructor(private readonly rules: readonly RedactionRule[]) {}

  redact(record: LogRecord): LogRecord {
    let fields = record.fields;
    for (const rule of this.rules) {
      fields = applyAtPath(fields, rule.fieldPath.split('.'), rule.strategy);
    }
    return {...record, fields};
  }
}
