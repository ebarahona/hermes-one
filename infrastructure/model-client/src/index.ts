// @platform-internal/model-client — infrastructure (none plane).
// The single-step model seam (ADR-021) + an OpenAI-compatible adapter behind it. NOTE: no canonical
// model-port spec doc exists; the SingleStepModel port here is authored JIT to ADR-021 (see port.ts).

export type {
  SingleStepModel,
  ModelResult,
  ModelMessage,
  ModelToolSpec,
  ModelUsage,
  ModelCompleteRequest,
} from './port.js';
export {createOpenAICompatibleModel, type ModelClientConfig} from './openai-compatible.js';

export const descriptor = {
  name: '@platform-internal/model-client',
  role: 'infrastructure',
  plane: 'none',
  published: false,
  sourceDocs: ['04-agent-runtime/054', '061'],
  governedBy: ['ADR-021'],
} as const;
