// Content hashing for compiled plans (ADR-016). A plan's identity is the
// sha256 of its canonical JSON — stable key ordering so two structurally-equal
// plans hash identically (replay + dedup). Pure compute (no I/O).
import {createHash} from 'node:crypto';
import type {ContentHash} from '@platform/contracts';

/** Recursively sort object keys for a stable serialization. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, canonical(val)]),
    );
  }
  return v;
}

export function contentHashOf(value: unknown): ContentHash {
  const json = JSON.stringify(canonical(value));
  const hex = createHash('sha256').update(json).digest('hex');
  return `sha256:${hex}` as ContentHash;
}
