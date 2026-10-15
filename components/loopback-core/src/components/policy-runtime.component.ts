// PolicyRuntimeComponent (edge): binds the policy runtime (ADR-019) — pre/post gate evaluation over
// a CompiledPolicyPlan.
import {Binding, type Component} from '@loopback/core';
import {BindingScope} from '@loopback/context';
import {builtinRegistry} from '@platform/expression-core';
import {ExpressionPolicyRuntime} from '@platform/policy-dsl';
import {PlatformBindings} from '../bindings.js';
import type {PlatformComponentBoundary} from '../boundary.js';

export class PolicyRuntimeComponent
  implements Component, PlatformComponentBoundary
{
  readonly plane = 'edge' as const;
  readonly bindsKeys = [PlatformBindings.POLICY_RUNTIME.key];
  readonly implementsExtensionPoints: readonly string[] = [];
  readonly consumesExtensionPoints: readonly string[] = [];
  readonly contributesTags: readonly string[] = [];

  bindings: Binding[] = [
    Binding.bind(PlatformBindings.POLICY_RUNTIME.key)
      .toDynamicValue(() => new ExpressionPolicyRuntime(builtinRegistry()))
      .inScope(BindingScope.SINGLETON),
  ];
}
