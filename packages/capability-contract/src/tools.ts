// Derive the set of capabilities an agent engine may actually use: the intersection of the engine's
// authored allowedCapabilities and the deployment's available contracts, then gated by the principal's
// scopes (ADR-019 — scopes drive tool visibility). A tool the principal lacks the requiredScope for is
// never surfaced, even if the engine allows it.
import type {
  CapabilityContract,
  CapabilityName,
  Scope,
} from '@hermes-one/contracts';

/** True if any granted scope covers `required` (segment-wise, `*` wildcards allowed in granted). */
export function scopeSatisfies(
  granted: readonly Scope[],
  required: Scope,
): boolean {
  const req = required.split('.');
  return granted.some(g => {
    const segs = g.split('.');
    if (segs.length !== req.length) return false;
    return segs.every((s, i) => s === '*' || s === req[i]);
  });
}

/** The scope-gated tool set for an engine: allowed ∩ available, visible only where scope permits. */
export function capabilitiesForEngine(
  allowed: readonly CapabilityName[],
  available: readonly CapabilityContract[],
  scopes: readonly Scope[],
): CapabilityContract[] {
  const allowedSet = new Set<string>(allowed);
  return available.filter(
    c => allowedSet.has(c.name) && scopeSatisfies(scopes, c.requiredScope),
  );
}
