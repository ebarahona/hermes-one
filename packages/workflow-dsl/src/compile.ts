// The workflow compiler (ADR-014): validate an authored WorkflowDefinition,
// derive the static edge adjacency, and produce an immutable content-hashed
// CompiledWorkflowPlan. Pure given injected identity/time. The plan is DATA —
// one interpreter walks it; there is no per-workflow code.
import {
  CompiledWorkflowPlan,
  WorkflowDefinition,
  type IsoTimestamp,
  type NodeId,
  type PlanId,
  type SemVer,
  type WorkflowNode,
} from '@hermes-one/contracts';
import {contentHashOf} from '@hermes-one/definition-substrate';

export class WorkflowCompileError extends Error {}

/** Static successor node ids of a node (for edge derivation + reachability). */
function successors(node: WorkflowNode): NodeId[] {
  switch (node.kind) {
    case 'agent':
    case 'capability':
    case 'childWorkflow':
    case 'wait':
      return [node.next];
    case 'rule':
      return Object.values(node.routes);
    case 'branch':
      return [node.then, node.else];
    case 'parallel':
      return [...node.branches, node.join];
    case 'join':
      return [node.next];
    case 'signalWait':
      return node.onTimeout ? [node.onSignal, node.onTimeout] : [node.onSignal];
    case 'terminal':
      return [];
  }
}

export interface WorkflowCompileOptions {
  compilerVersion: SemVer;
  planId: PlanId;
  compiledAt: IsoTimestamp;
}

export function compileWorkflow(
  definition: WorkflowDefinition,
  opts: WorkflowCompileOptions,
): CompiledWorkflowPlan {
  const def = WorkflowDefinition.parse(definition);
  const graph = def.body.nodes;

  // Structural checks: entry exists; every successor references a real node.
  if (!graph[def.body.entry]) {
    throw new WorkflowCompileError(
      `entry node '${def.body.entry}' not in graph`,
    );
  }
  const edges: {from: NodeId; to: NodeId}[] = [];
  for (const [id, node] of Object.entries(graph)) {
    for (const to of successors(node)) {
      if (!graph[to]) {
        throw new WorkflowCompileError(
          `node '${id}' points to missing node '${to}'`,
        );
      }
      edges.push({from: id as NodeId, to});
    }
  }
  // A rule node must have a `default` route (first-match fallthrough).
  for (const [id, node] of Object.entries(graph)) {
    if (node.kind === 'rule' && !node.routes['default']) {
      throw new WorkflowCompileError(
        `rule node '${id}' has no 'default' route`,
      );
    }
  }

  const core = {
    kind: 'workflow' as const,
    definitionId: def.definitionId,
    version: def.version,
    compilerVersion: opts.compilerVersion,
    entry: def.body.entry,
    graph,
    edges,
  };

  return CompiledWorkflowPlan.parse({
    planId: opts.planId,
    contentHash: contentHashOf(core),
    compiledAt: opts.compiledAt,
    ...core,
  });
}
