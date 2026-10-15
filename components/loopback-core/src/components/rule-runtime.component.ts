// RuleRuntimeComponent (edge): binds the deterministic rule runtime (ADR-015) — pure, synchronous
// evaluation over the pinned operator registry.
import {Binding, type Component} from '@loopback/core';
import {BindingScope} from '@loopback/context';
import type {SemVer} from '@platform/contracts';
import {builtinRegistry} from '@platform/expression-core';
import {createRuleRuntime} from '@platform/rule-dsl';
import {PlatformBindings} from '../bindings.js';
import type {PlatformComponentBoundary} from '../boundary.js';

const OPERATOR_REGISTRY_VERSION = '1.0.0' as SemVer;

export class RuleRuntimeComponent
  implements Component, PlatformComponentBoundary
{
  readonly plane = 'edge' as const;
  readonly bindsKeys = [PlatformBindings.RULE_RUNTIME.key];
  readonly implementsExtensionPoints: readonly string[] = [];
  readonly consumesExtensionPoints: readonly string[] = [];
  readonly contributesTags: readonly string[] = [];

  bindings: Binding[] = [
    Binding.bind(PlatformBindings.RULE_RUNTIME.key)
      .toDynamicValue(() =>
        createRuleRuntime(builtinRegistry(OPERATOR_REGISTRY_VERSION)),
      )
      .inScope(BindingScope.SINGLETON),
  ];
}
