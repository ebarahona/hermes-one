// SubstrateComponent (edge): binds the definition-substrate SERVICES over the already-bound content-
// addressed store + tenant-scoped repos. DeploymentService (Slice 6, reads)
// + DefinitionRegistry (Slice 8, put — authoring, with the logic-DSL compilers wired). Retires part
// of ledger L1 (services were only ad-hoc-constructed in apps/workflow-worker/src/publish.ts).
import {Binding, BindingScope, type Component} from '@loopback/core';
import {
  DrizzleDefinitionRepository,
  DrizzleDeploymentRepository,
} from '@platform-internal/drizzle';
import {
  type CompileFn,
  DefinitionRegistry,
  type DefinitionRegistryDeps,
  DeploymentService,
  type DeploymentServiceDeps,
} from '@platform/definition-substrate';
import {builtinRegistry} from '@platform/expression-core';
import {compileRule} from '@platform/rule-dsl';
import {compileWorkflow} from '@platform/workflow-dsl';
import {compilePolicy} from '@platform/policy-dsl';
import type {SemVer} from '@platform/contracts';
import {PlatformBindings} from '../bindings.js';
import type {PlatformComponentBoundary} from '../boundary.js';

const COMPILER_VERSION = '1.0.0' as SemVer;

/** The logic-DSL compilers (workflow/rule/policy), pinned to the operator registry — mirrors the
 *  wiring in apps/workflow-worker/src/publish.ts. Contract-schema kinds (capability/agent-engine)
 *  need no compiler (validate-and-pin). */
function buildCompilers(): DefinitionRegistryDeps['compilers'] {
  const opreg = builtinRegistry(COMPILER_VERSION);
  return {
    workflow: (def, ctx) =>
      compileWorkflow(def as never, {
        compilerVersion: ctx.compilerVersion,
        planId: ctx.planId,
        compiledAt: ctx.compiledAt as never,
      }),
    rule: (def, ctx) =>
      compileRule(def as never, {
        registry: opreg,
        compilerVersion: ctx.compilerVersion,
        planId: ctx.planId,
        compiledAt: ctx.compiledAt as never,
      }),
    policy: (def, ctx) =>
      compilePolicy(def as never, {
        registry: opreg,
        compilerVersion: ctx.compilerVersion,
        planId: ctx.planId,
        compiledAt: ctx.compiledAt as never,
      }),
  } satisfies Record<'workflow' | 'rule' | 'policy', CompileFn>;
}

export class SubstrateComponent
  implements Component, PlatformComponentBoundary
{
  readonly plane = 'edge' as const;
  readonly bindsKeys = [
    PlatformBindings.DEPLOYMENT_SERVICE.key,
    PlatformBindings.DEFINITION_REGISTRY.key,
  ];
  readonly implementsExtensionPoints: readonly string[] = [];
  readonly consumesExtensionPoints: readonly string[] = [];
  readonly contributesTags: readonly string[] = [];

  bindings: Binding[] = [
    Binding.bind(PlatformBindings.DEPLOYMENT_SERVICE.key)
      .toDynamicValue(({context}) => {
        const deps: DeploymentServiceDeps = {
          store: context.getSync(PlatformBindings.COMPILED_PLAN_STORE),
          deployments: new DrizzleDeploymentRepository(
            context.getSync(PlatformBindings.POSTGRES).db,
          ),
          now: () => new Date().toISOString(),
        };
        return new DeploymentService(deps);
      })
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.DEFINITION_REGISTRY.key)
      .toDynamicValue(({context}) => {
        const deps: DefinitionRegistryDeps = {
          store: context.getSync(PlatformBindings.COMPILED_PLAN_STORE),
          definitions: new DrizzleDefinitionRepository(
            context.getSync(PlatformBindings.POSTGRES).db,
          ),
          compilers: buildCompilers(),
          compilerVersion: COMPILER_VERSION,
          now: () => new Date().toISOString(),
        };
        return new DefinitionRegistry(deps);
      })
      .inScope(BindingScope.SINGLETON),
  ];
}
