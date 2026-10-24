// PlatformReject — the SINGLE error exit for the REST surface (the "error-normalize" step /
// the Reject sequence action). Every thrown error, from any middleware or
// controller, normalizes here to the one wire shape `{ error: PlatformError }`.
// A PlatformErrorException passes its PlatformError
// through untouched; anything else collapses to a generic 500 `internal_error` (no leakage).
import {injectable, type Provider} from '@loopback/core';
import {type HandlerContext, type Reject} from '@loopback/rest';
import {
  type PlatformError,
  PlatformErrorException,
} from '@hermes-one/contracts';
import {CORRELATION_ID_REQUEST_KEY} from './correlation.middleware.js';

// Bound over RestBindings.SequenceActions.REJECT by registerPlatformRestSequence (register.ts).
@injectable()
export class PlatformReject implements Provider<Reject> {
  value(): Reject {
    return ({request, response}: HandlerContext, err: unknown) => {
      const correlationId = (request as unknown as Record<string, unknown>)[
        CORRELATION_ID_REQUEST_KEY
      ] as string | undefined;

      let error: PlatformError;
      if (err instanceof PlatformErrorException) {
        error = {
          ...err.error,
          correlationId: err.error.correlationId ?? correlationId,
        };
      } else {
        // Unexpected — never surface internals over the wire (matches bootstrap's fatal-log posture).
        console.error('[rest] unhandled error', {
          correlationId,
          err: String(err),
        });
        error = {
          category: 'internal',
          code: 'internal_error',
          message: 'Internal error.',
          issues: [],
          retryable: false,
          httpStatus: 500,
          correlationId,
        };
      }

      if (correlationId) response.setHeader('X-Correlation-Id', correlationId);
      response.status(error.httpStatus);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({error}));
    };
  }
}
