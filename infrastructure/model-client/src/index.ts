// @platform-internal/model-client — infrastructure (none plane).
// The single-step model seam (ADR-021) + an OpenAI-compatible adapter behind it. NOTE: the
// SingleStepModel port here is authored to ADR-021 (see port.ts).

export type {
  SingleStepModel,
  ModelResult,
  ModelMessage,
  ModelToolSpec,
  ModelUsage,
  ModelCompleteRequest,
} from './port.js';
export {
  createOpenAICompatibleModel,
  type ModelClientConfig,
} from './openai-compatible.js';

export const descriptor = {
  name: '@platform-internal/model-client',
  role: 'infrastructure',
  plane: 'none',
  published: false,
  governedBy: ['ADR-021'],
} as const;
