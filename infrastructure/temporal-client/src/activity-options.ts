// JIT helpers (flagged — no contract names these; they are the mechanical projections consumers
// need to use the registry, not new policy):
// - `toTemporalActivityOptions` maps an `ActivityOptionsSpec` onto Temporal's `ActivityOptions`
//   field-for-field, dropping `rationale` (operability metadata, not a Temporal field).
// - `withPlatformFailures` applies the rule that every activity
//   implementation calls `toApplicationFailure` in its catch path ONCE at the worker registration
//   boundary, so a thrown `PlatformErrorException` always reaches Temporal as the stable typed
//   `ApplicationFailure` the registry's `nonRetryableErrorTypes` can match.
import type {Duration} from '@temporalio/common';
import {PlatformErrorException} from '@platform/contracts';
import {toApplicationFailure, type ActivityOptionsSpec} from './retry-policy.js';

/** The subset of Temporal's ActivityOptions the registry drives (durations as Temporal strings). */
export interface TemporalActivityOptions {
  startToCloseTimeout: Duration;
  scheduleToCloseTimeout?: Duration;
  heartbeatTimeout?: Duration;
  retry: {
    initialInterval: Duration;
    backoffCoefficient: number;
    maximumInterval: Duration;
    maximumAttempts: number;
    nonRetryableErrorTypes: string[];
  };
}

export function toTemporalActivityOptions(spec: ActivityOptionsSpec): TemporalActivityOptions {
  const {rationale: _rationale, retry, ...timeouts} = spec;
  // DurationString's regex (retry-policy.ts) guarantees the ms-compatible format Temporal's
  // template-literal Duration type encodes — the assertions narrow, they don't invent.
  return {
    ...timeouts,
    retry: {...retry, nonRetryableErrorTypes: [...retry.nonRetryableErrorTypes]},
  } as TemporalActivityOptions;
}

type AnyActivity = (...args: never[]) => Promise<unknown>;

/** Wrap a worker's activity map so every thrown PlatformErrorException becomes a typed ApplicationFailure. */
export function withPlatformFailures<T extends Record<string, AnyActivity>>(activities: T): T {
  return Object.fromEntries(
    Object.entries(activities).map(([name, fn]) => [
      name,
      async (...args: never[]) => {
        try {
          return await fn(...args);
        } catch (err) {
          if (err instanceof PlatformErrorException) throw toApplicationFailure(err.error);
          throw err;
        }
      },
    ]),
  ) as T;
}
