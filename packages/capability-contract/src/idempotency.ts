// Idempotency-key derivation for a write/external/payment capability. The key material is the turnId,
// the capability name, and the values of the contract's declared keyFields — so a replayed identical
// call within a turn collapses, while a different turn (or different inputs) does not.
import type {CapabilityContract} from '@hermes-one/contracts';

function atPath(input: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, seg) =>
        acc && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[seg]
          : undefined,
      input,
    );
}

/** `${turnId}:${name}:${keyFieldValues...}` — matches the tool_executions idempotency_key format. */
export function deriveIdempotencyKey(
  cap: CapabilityContract,
  input: Record<string, unknown>,
  turnId: string,
): string {
  const parts = cap.idempotency.keyFields.map(p =>
    JSON.stringify(atPath(input, p) ?? null),
  );
  return [turnId, cap.name, ...parts].join(':');
}
