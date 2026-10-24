// Plan-load activities (ADR-014): load a compiled plan once, content-hash-verified, over the injected
// CompiledPlanStore port. The store's cache-through + mandatory hash check happen inside
// resolvePlanCached; the returned plan_body IS the full compiled plan. The worker (composition root)
// wires the concrete Drizzle store; activities depend on the port.
import type {CompiledPlanStore} from '@hermes-one/drizzle';
import type {
  CompiledRulePlan,
  CompiledWorkflowPlan,
  ContentHash,
  PlanId,
  TenantId,
} from '@hermes-one/contracts';

export interface PlanLoadArgs {
  tenantId: string;
  planId: string;
  contentHash: string;
}

/** Build the plan-load activities over an injected CompiledPlanStore. */
export function createPlanActivities(store: CompiledPlanStore) {
  return {
    async loadWorkflowPlan(a: PlanLoadArgs): Promise<CompiledWorkflowPlan> {
      const plan = await store.resolvePlanCached(
        a.tenantId as TenantId,
        a.planId as PlanId,
        a.contentHash as ContentHash,
      );
      return plan as CompiledWorkflowPlan;
    },
    async loadRulePlan(a: PlanLoadArgs): Promise<CompiledRulePlan> {
      const plan = await store.resolvePlanCached(
        a.tenantId as TenantId,
        a.planId as PlanId,
        a.contentHash as ContentHash,
      );
      return plan as CompiledRulePlan;
    },
  };
}
