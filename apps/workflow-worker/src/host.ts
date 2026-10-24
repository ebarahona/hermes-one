// Host-workflow selection (ADR-014): the ingest edge starts the host that can execute every node kind
// in the tenant's compiled entry workflow. Pure — the caller loads the plan.
import type {CompiledWorkflowPlan} from '@hermes-one/contracts';

/** The registered host workflows (export names in workflows.ts). */
export type HostWorkflowName = 'runCompiledWorkflow' | 'runAgentWorkflow';

/** A plan with any agent node needs the agent host (pinned deployment + principal); else deterministic. */
export function selectHostWorkflow(
  plan: Pick<CompiledWorkflowPlan, 'graph'>,
): HostWorkflowName {
  return Object.values(plan.graph).some(node => node.kind === 'agent')
    ? 'runAgentWorkflow'
    : 'runCompiledWorkflow';
}
