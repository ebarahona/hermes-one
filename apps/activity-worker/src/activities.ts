// Edge-plane Temporal activities (the non-agent effects the workflow delegates).
// Run in the normal Node context (I/O allowed). `evaluateRule` is the ADR-023 activity; the capability
// node's side effect is `invokeCapability` in capability-activities.ts (over the real capability plane).
// Hosted by activity-worker on task queue `hermes-activity`.
import type {
  CompiledRulePlan,
  IsoTimestamp,
  RuleFacts,
  SemVer,
} from '@platform/contracts';
import {builtinRegistry} from '@platform/expression-core';
import {createRuleRuntime} from '@platform/rule-dsl';

const registry = builtinRegistry('1.0.0' as SemVer);
const runtime = createRuleRuntime(registry);

export async function evaluateRule(a: {
  rulePlan: CompiledRulePlan;
  parameters: Record<string, unknown>;
  facts: RuleFacts;
  now: IsoTimestamp;
}): Promise<{outcome: string; emit?: Record<string, unknown>}> {
  const res = runtime.evaluate(a.rulePlan, {
    facts: a.facts,
    now: a.now,
    parameters: a.parameters,
    operatorRegistryVersion: '1.0.0' as SemVer,
  });
  return {outcome: res.outcome, emit: res.emit};
}
