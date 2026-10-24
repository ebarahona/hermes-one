// @hermes-one/temporal-client — infrastructure (none plane). The canonical Temporal
// retry-policy registry: six ActivityOptions classes, the
// ErrorCode→ApplicationFailure.type crosswalk, and the generated nonRetryableErrorTypes list.

export const descriptor = {
  name: '@hermes-one/temporal-client',
  role: 'infrastructure',
  plane: 'none',
  published: false,
  governedBy: [],
} as const;

export * from './retry-policy.js';
export * from './activity-options.js';
export * from './trace-propagation.js';
export * from './versioning.js';
