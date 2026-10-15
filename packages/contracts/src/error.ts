// @platform/contracts — src/error.ts
import {z} from 'zod';

/* --------------------------- Categories & codes ------------------------ */

export const ErrorCategory = z.enum([
  'validation', // input/output schema violation
  'authorization', // voter/gate deny, scope missing
  'not-found', // subject missing
  'conflict', // idempotency / version conflict
  'rate-limited', // quota / 429
  'payment', // @price / x402 / 402
  'provider', // downstream vendor failure
  'infrastructure', // transport/DB/network — retryable class
  'timeout', // deadline exceeded
  'policy', // policy-required stop (defer/approval/handoff surfaced as error at a boundary)
  'internal', // unexpected platform bug
]);
export type ErrorCategory = z.infer<typeof ErrorCategory>;

/** Closed, stable machine-actionable codes (agentback-style stable `code`). */
export const ErrorCode = z.enum([
  'validation_failed',
  'output_validation_failed',
  'unauthorized',
  'forbidden_scope',
  'not_found',
  'idempotency_conflict',
  'version_conflict',
  'rate_limited',
  'quota_exceeded',
  'payment_required', // 402 — the code agentback's error set omits
  'provider_unavailable',
  'provider_rejected', // vendor business rejection (handler-error class)
  'infrastructure_error', // retryable (transport-core infrastructure-error)
  'deadline_exceeded',
  'confirmation_required', // agentback confirm: first-call refusal
  'policy_blocked',
  'tenant_not_resolved',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/* --------------------------- Field issues ------------------------------ */

export const ErrorIssue = z.object({
  path: z.string(), // JSON pointer / field path
  message: z.string(),
  expected: z.string().optional(),
});
export type ErrorIssue = z.infer<typeof ErrorIssue>;

/* --------------------------- PlatformError ----------------------------- */

export const PlatformError = z.object({
  category: ErrorCategory,
  code: ErrorCode,
  message: z.string().min(1),
  /** Per-field issues (from agentback/Zod validation). */
  issues: z.array(ErrorIssue).default([]),
  /** The violated schema id/ref, when applicable (agentback carries this). */
  schema: z.string().optional(),
  retryable: z.boolean(),
  /** Machine/agent remediation hint (agentback carries this). */
  remediation: z.string().optional(),
  /** HTTP projection (402 for payment, 429 rate-limit, etc.). */
  httpStatus: z.number().int().min(400).max(599),
  /** Correlate to the audit/usage chain. */
  correlationId: z.string().optional(),
  /** Payment challenge detail for 402 (x402 / MPP). */
  payment: z
    .object({
      priceUsd: z.string(),
      challenge: z.string().optional(),
      scheme: z.enum(['x402', 'mpp']),
    })
    .optional(),
});
export type PlatformError = z.infer<typeof PlatformError>;

/** Throwable wrapper (Temporal-serializable via ApplicationFailure details). */
export class PlatformErrorException extends Error {
  constructor(public readonly error: PlatformError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'PlatformErrorException';
  }
}

/* ----------------------------- Mappers --------------------------------- */

/** transport-core HandlerResult.outcome → category (lib-findings). */
export const HANDLER_OUTCOME_TO_CATEGORY: Record<
  'success' | 'handler-error' | 'infrastructure-error',
  ErrorCategory | 'success'
> = {
  success: 'success',
  'handler-error': 'provider', // business rejection → not retryable by default
  'infrastructure-error': 'infrastructure', // transport/broker failure → retryable
};

/** Default retryability per category (Temporal retry vs handoff decision). */
export const RETRYABLE_BY_CATEGORY: Record<ErrorCategory, boolean> = {
  validation: false,
  authorization: false,
  'not-found': false,
  conflict: false,
  'rate-limited': true,
  payment: false,
  provider: false,
  infrastructure: true,
  timeout: true,
  policy: false,
  internal: false,
};

/** HTTP status per code (402 explicitly present). */
export const HTTP_STATUS_BY_CODE: Record<z.infer<typeof ErrorCode>, number> = {
  validation_failed: 422,
  output_validation_failed: 500,
  unauthorized: 401,
  forbidden_scope: 403,
  not_found: 404,
  idempotency_conflict: 409,
  version_conflict: 409,
  rate_limited: 429,
  quota_exceeded: 429,
  payment_required: 402,
  provider_unavailable: 502,
  provider_rejected: 422,
  infrastructure_error: 503,
  deadline_exceeded: 504,
  confirmation_required: 428, // Precondition Required
  policy_blocked: 403,
  tenant_not_resolved: 403,
  internal_error: 500,
};

/** Normalize an agentback error envelope into a PlatformError (no information loss). */
export interface AgentbackErrorEnvelope {
  code: string;
  message: string;
  issues?: {path: string; message: string; expected?: string}[];
  schema?: string;
  retryable?: boolean;
  remediation?: string;
  httpStatus?: number;
  price?: string;
}
export function toPlatformError(
  e: AgentbackErrorEnvelope,
  correlationId?: string,
): PlatformError {
  /* impl in agentback/ */
  throw new Error('see agentback/ pack for the reference implementation');
}
