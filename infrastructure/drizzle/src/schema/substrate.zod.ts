// drizzle-zod row schemas + compile-time alignment guards against @platform/contracts (ADR-020/022).
import {createSelectSchema} from 'drizzle-zod';
import {
  CompiledPlanBase,
  ValidatedContractBase,
  DeploymentMember,
} from '@platform/contracts';
import {
  compiledPlans,
  validatedContracts,
  deployments,
  deploymentMembers,
} from './substrate.schema.js';

export const CompiledPlanRow = createSelectSchema(compiledPlans);
export const ValidatedContractRow = createSelectSchema(validatedContracts);
export const DeploymentRow = createSelectSchema(deployments);
export const DeploymentMemberRow = createSelectSchema(deploymentMembers);

/** Compile-time alignment guards — fail the build if a migration drifts a contract-facing column. */
export type _AssertCompiledPlanAligned =
  CompiledPlanBase extends Pick<
    ReturnType<typeof CompiledPlanRow.parse>,
    | 'planId'
    | 'definitionId'
    | 'kind'
    | 'version'
    | 'contentHash'
    | 'compilerVersion'
    | 'compiledAt'
  >
    ? true
    : never;

export type _AssertValidatedContractAligned =
  ValidatedContractBase extends Pick<
    ReturnType<typeof ValidatedContractRow.parse>,
    | 'definitionId'
    | 'kind'
    | 'version'
    | 'contentHash'
    | 'validatedAt'
    | 'schemaRef'
  >
    ? true
    : never;

export type _AssertDeploymentMemberAligned =
  DeploymentMember extends Pick<
    ReturnType<typeof DeploymentMemberRow.parse>,
    'kind' | 'definitionId' | 'planId' | 'version' | 'contentHash'
  >
    ? true
    : never;
