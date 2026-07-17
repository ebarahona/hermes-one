// @platform-internal/temporal-client — infrastructure (none plane). The canonical Temporal
// retry-policy registry (temporal/retry-policy-registry.md): six ActivityOptions classes, the
// ErrorCode→ApplicationFailure.type crosswalk, and the generated nonRetryableErrorTypes list.

export const descriptor = {
  name: '@platform-internal/temporal-client',
  role: 'infrastructure',
  plane: 'none',
  published: false,
  sourceDocs: ['03-workflow-runtime/043', 'temporal/retry-policy-registry', 'observability/tracing-metrics-logging'],
  governedBy: [],
} as const;

export * from './retry-policy.js';
export * from './activity-options.js';
export * from './trace-propagation.js';
export * from './versioning.js';
