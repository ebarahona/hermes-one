// Unit tests for the retry-policy registry.
// The two live-Temporal integration rows (idempotent-write replay safety, guarded-write no
// auto-retry) are exercised by the apps' e2es; the forced-failure harness is deferred (flagged).
import {describe, expect, it} from 'vitest';
import {
  ErrorCode,
  HTTP_STATUS_BY_CODE,
  type PlatformError,
  type SideEffectClass,
} from '@hermes-one/contracts';
import {
  ACTIVITY_CATEGORY_TO_RETRY_POLICY_CLASS,
  ActivityCategory,
  ActivityOptionsSpec,
  CATEGORY_BY_CODE,
  ERROR_CODE_TO_APPLICATION_FAILURE_TYPE,
  NON_RETRYABLE_ERROR_TYPES,
  RETRY_POLICY_REGISTRY,
  RetryPolicyClass,
  resolveEffectiveActivityOptions,
  retryPolicyClassForCapability,
  toApplicationFailure,
} from './retry-policy.js';
import {
  toTemporalActivityOptions,
  withPlatformFailures,
} from './activity-options.js';
import {PlatformErrorException} from '@hermes-one/contracts';

const platformError = (code: ErrorCode, retryable: boolean): PlatformError => ({
  category: CATEGORY_BY_CODE[code],
  code,
  message: `test ${code}`,
  issues: [],
  retryable,
  httpStatus: HTTP_STATUS_BY_CODE[code],
});

describe('retry-policy registry', () => {
  it('maps all 7 fixed activity categories to exactly one of the 6 classes', () => {
    const fixed = ActivityCategory.options.filter(
      c => c !== 'capability-execution',
    );
    for (const category of fixed) {
      const cls =
        ACTIVITY_CATEGORY_TO_RETRY_POLICY_CLASS[
          category as keyof typeof ACTIVITY_CATEGORY_TO_RETRY_POLICY_CLASS
        ];
      expect(RetryPolicyClass.options).toContain(cls);
    }
    expect(fixed).toHaveLength(7);
  });

  it('resolves capability execution dynamically by SideEffectClass', () => {
    const cases: Record<SideEffectClass, RetryPolicyClass> = {
      none: 'read-only-provider',
      read: 'read-only-provider',
      write: 'idempotent-write',
      external: 'non-idempotent-guarded-write',
      payment: 'non-idempotent-guarded-write',
    };
    for (const [sideEffect, expected] of Object.entries(cases)) {
      expect(retryPolicyClassForCapability(sideEffect as SideEffectClass)).toBe(
        expected,
      );
    }
  });

  it('generates exactly the 14 non-retryable types and excludes the 4 retryable ones', () => {
    expect(NON_RETRYABLE_ERROR_TYPES).toHaveLength(14);
    for (const excluded of [
      'RateLimitedError',
      'QuotaExceededError',
      'InfrastructureError',
      'DeadlineExceededError',
    ]) {
      expect(NON_RETRYABLE_ERROR_TYPES).not.toContain(excluded);
    }
    for (const included of [
      'ValidationFailedError',
      'OutputValidationFailedError',
      'UnauthorizedError',
      'ForbiddenScopeError',
      'NotFoundError',
      'IdempotencyConflictError',
      'VersionConflictError',
      'PaymentRequiredError',
      'ProviderUnavailableError',
      'ProviderRejectedError',
      'ConfirmationRequiredError',
      'PolicyBlockedError',
      'TenantNotResolvedError',
      'InternalError',
    ]) {
      expect(NON_RETRYABLE_ERROR_TYPES).toContain(included);
    }
  });

  it('crosswalk is a bijection: 18 unique, Error-suffixed, never doubled type strings', () => {
    const types = Object.values(ERROR_CODE_TO_APPLICATION_FAILURE_TYPE);
    expect(types).toHaveLength(ErrorCode.options.length);
    expect(new Set(types).size).toBe(types.length);
    for (const t of types) {
      expect(t).toMatch(/Error$/);
      expect(t).not.toMatch(/ErrorError$/);
    }
  });

  it('toApplicationFailure preserves type, retryability, and the whole PlatformError in details', () => {
    const err = platformError('provider_unavailable', false);
    const failure = toApplicationFailure(err);
    expect(failure.type).toBe('ProviderUnavailableError');
    expect(failure.nonRetryable).toBe(true);
    expect(failure.details?.[0]).toEqual(err);

    const retryable = toApplicationFailure(
      platformError('infrastructure_error', true),
    );
    expect(retryable.type).toBe('InfrastructureError');
    expect(retryable.nonRetryable).toBe(false);
  });

  it('refines the non-retryable shorthand list (PolicyBlockedError verbatim; validation/authorization covered)', () => {
    expect(NON_RETRYABLE_ERROR_TYPES).toContain('PolicyBlockedError');
    expect(
      NON_RETRYABLE_ERROR_TYPES.filter(t =>
        ['ValidationFailedError', 'OutputValidationFailedError'].includes(t),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      NON_RETRYABLE_ERROR_TYPES.filter(t =>
        ['UnauthorizedError', 'ForbiddenScopeError'].includes(t),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('model-call reproduces the agentTurn defaults (120s/20s/1) exactly', () => {
    const modelCall = RETRY_POLICY_REGISTRY['model-call'];
    expect(modelCall.startToCloseTimeout).toBe('120s');
    expect(modelCall.heartbeatTimeout).toBe('20s');
    expect(modelCall.retry.maximumAttempts).toBe(1);
  });

  it('non-idempotent-guarded-write is attempt-once', () => {
    expect(
      RETRY_POLICY_REGISTRY['non-idempotent-guarded-write'].retry
        .maximumAttempts,
    ).toBe(1);
  });

  it('override only tightens maximumAttempts, never loosens', () => {
    const tightened = resolveEffectiveActivityOptions('human-task-dispatch', {
      maximumAttempts: 3,
    });
    expect(tightened.retry.maximumAttempts).toBe(3);
    const refused = resolveEffectiveActivityOptions('human-task-dispatch', {
      maximumAttempts: 20,
    });
    expect(refused.retry.maximumAttempts).toBe(6);
    const untouched = resolveEffectiveActivityOptions('human-task-dispatch');
    expect(untouched.retry.maximumAttempts).toBe(6);
  });

  it('every registry entry validates against ActivityOptionsSpec and shares the ONE generated list', () => {
    for (const cls of RetryPolicyClass.options) {
      const entry = RETRY_POLICY_REGISTRY[cls];
      expect(() => ActivityOptionsSpec.parse(entry)).not.toThrow();
      expect(entry.retry.nonRetryableErrorTypes).toEqual([
        ...NON_RETRYABLE_ERROR_TYPES,
      ]);
    }
    expect(Object.keys(RETRY_POLICY_REGISTRY)).toHaveLength(6);
  });

  it('toTemporalActivityOptions drops rationale and keeps every Temporal field', () => {
    const opts = toTemporalActivityOptions(
      RETRY_POLICY_REGISTRY['internal-db'],
    );
    expect(opts).not.toHaveProperty('rationale');
    expect(opts.startToCloseTimeout).toBe('10s');
    expect(opts.retry.maximumAttempts).toBe(10);
    expect(opts.retry.nonRetryableErrorTypes).toEqual([
      ...NON_RETRYABLE_ERROR_TYPES,
    ]);
  });

  it('withPlatformFailures rethrows PlatformErrorException as the typed ApplicationFailure', async () => {
    const activities = withPlatformFailures({
      async boom(): Promise<void> {
        throw new PlatformErrorException(
          platformError('validation_failed', false),
        );
      },
      async fine(): Promise<string> {
        return 'ok';
      },
    });
    await expect(activities.fine()).resolves.toBe('ok');
    const thrown = await activities.boom().catch((e: unknown) => e);
    expect((thrown as {type?: string}).type).toBe('ValidationFailedError');
    expect((thrown as {nonRetryable?: boolean}).nonRetryable).toBe(true);
  });

  it('withPlatformFailures leaves non-platform errors untouched', async () => {
    const activities = withPlatformFailures({
      async plain(): Promise<void> {
        throw new Error('raw');
      },
    });
    const thrown = await activities.plain().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('raw');
    expect((thrown as {type?: string}).type).toBeUndefined();
  });
});
