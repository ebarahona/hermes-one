// @hermes-one/definition-substrate — package (none plane).
// Shared substrate lifecycle pieces (ADR-016): content-hashing today; the
// versioned-schema registry + deployment manifest to follow.

export {contentHashOf} from './content-hash.js';
export {
  DefinitionRegistry,
  type CompileFn,
  type DefinitionRegistryDeps,
  type PutDefinitionResult,
  type CompileDiagnostic,
} from './registry.js';
export {definitionPublishedEvent, deploymentPublishedEvent} from './events.js';
export {
  DeploymentService,
  type PublishDeploymentInput,
  type DeploymentValidation,
  type DeploymentServiceDeps,
} from './deployment.js';
export type {
  PlanStorePort,
  DefinitionWritePort,
  DeploymentWritePort,
  DefinitionRowLike,
  DefinitionVersionRowLike,
  DeploymentRowInputLike,
  DeploymentMemberInputLike,
} from './ports.js';

export const descriptor = {
  name: '@hermes-one/definition-substrate',
  role: 'package',
  plane: 'none',
  published: true,
  governedBy: ['ADR-016'],
} as const;
