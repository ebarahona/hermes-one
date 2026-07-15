// SubstrateComponent (edge): binds the definition-substrate SERVICES over the already-bound
// content-addressed store + a tenant-scoped deployment repo (substrate-lifecycle.md). Slice 6 binds
// DeploymentService (the read path — resolveActive/resolveVersion — delegates to the store; publish/
// rollback use the deployment write repo). DefinitionRegistry (needs the logic-DSL compilers) lands
// with the definition controllers. Retires part of ledger L1 (services were only ad-hoc-constructed
// in apps/workflow-worker/src/publish.ts).
import {Binding, BindingScope, type Component} from '@loopback/core';
import {DrizzleDeploymentRepository} from '@platform-internal/drizzle';
import {DeploymentService, type DeploymentServiceDeps} from '@platform/definition-substrate';
import {PlatformBindings} from '../bindings.js';
import type {PlatformComponentBoundary} from '../boundary.js';

export class SubstrateComponent implements Component, PlatformComponentBoundary {
  readonly plane = 'edge' as const;
  readonly bindsKeys = [PlatformBindings.DEPLOYMENT_SERVICE.key];
  readonly implementsExtensionPoints: readonly string[] = [];
  readonly consumesExtensionPoints: readonly string[] = [];
  readonly contributesTags: readonly string[] = [];

  bindings: Binding[] = [
    Binding.bind(PlatformBindings.DEPLOYMENT_SERVICE.key)
      .toDynamicValue(({context}) => {
        const deps: DeploymentServiceDeps = {
          store: context.getSync(PlatformBindings.COMPILED_PLAN_STORE),
          deployments: new DrizzleDeploymentRepository(context.getSync(PlatformBindings.POSTGRES).db),
          now: () => new Date().toISOString(),
        };
        return new DeploymentService(deps);
      })
      .inScope(BindingScope.SINGLETON),
  ];
}
