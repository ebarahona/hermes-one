// Workflow definition substrate contracts (ADR-014). A workflow is authored as
// data (a node graph), compiled to an immutable content-hashed plan, and walked
// by ONE interpreter (executeCompiledWorkflow) — never a Temporal file per
// business process. The workflow ROUTES; it owns orchestration and long waits.
import {z} from 'zod';
import {
  CompiledPlanBase,
  ContentHash,
  DefinitionId,
  DeploymentRef,
  IsoTimestamp,
  PlanId,
  SemVer,
} from './substrate.js';
import {WorkspaceContext} from './tenant.js';

/* --------------------------- Node identifiers -------------------------- */
export const NodeId = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/)
  .brand('NodeId');
export type NodeId = z.infer<typeof NodeId>;

/** Reference into the tenant's active deployment for a pinned rule/capability/agent-engine. */
export const PinnedRef = z.object({
  definitionId: DefinitionId,
  version: SemVer,
  contentHash: ContentHash,
});
export type PinnedRef = z.infer<typeof PinnedRef>;

/* ----------------------- Authored node union (DSL) --------------------- */

const NodeBase = z.object({
  id: NodeId,
  label: z.string().max(120).optional(),
});

/** Runs a bounded agent turn (agent plane) as an activity. */
export const AgentNode = NodeBase.extend({
  kind: z.literal('agent'),
  agentEngine: PinnedRef,
  objective: z.string().min(1),
  next: NodeId,
});

/** Invokes a provider-neutral capability as an activity (idempotent side effect). */
export const CapabilityNode = NodeBase.extend({
  kind: z.literal('capability'),
  capability: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+){2}$/),
  input: z.record(z.string(), z.unknown()),
  next: NodeId,
});

/** Evaluates a pinned rule over gathered facts; routes on the outcome. */
export const RuleNode = NodeBase.extend({
  kind: z.literal('rule'),
  rule: PinnedRef,
  /** Fact expressions gathered by an activity before evaluation (operators do no I/O). */
  facts: z.record(z.string(), z.unknown()),
  /** Outcome label → next node. `default` required. */
  routes: z.record(z.string(), NodeId),
});

export const ParallelNode = NodeBase.extend({
  kind: z.literal('parallel'),
  branches: z.array(NodeId).min(2),
  join: NodeId,
});

export const JoinNode = NodeBase.extend({
  kind: z.literal('join'),
  strategy: z.enum(['all', 'any', 'race']).default('all'),
  next: NodeId,
});

export const ChildWorkflowNode = NodeBase.extend({
  kind: z.literal('childWorkflow'),
  workflow: PinnedRef,
  input: z.record(z.string(), z.unknown()),
  next: NodeId,
});

/** Durable wait at the WORKFLOW level (long waits never live in the turn). */
export const WaitNode = NodeBase.extend({
  kind: z.literal('wait'),
  durationMs: z.number().int().positive(),
  next: NodeId,
});

export const SignalWaitNode = NodeBase.extend({
  kind: z.literal('signalWait'),
  signal: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  onSignal: NodeId,
  onTimeout: NodeId.optional(),
});

/** Pure routing on a shared-expression predicate (no side effects). */
export const BranchNode = NodeBase.extend({
  kind: z.literal('branch'),
  when: z.string().min(1),
  then: NodeId,
  else: NodeId,
});

export const TerminalNode = NodeBase.extend({
  kind: z.literal('terminal'),
  outcome: z.enum(['completed', 'handoff', 'abandoned', 'failed']),
  result: z.record(z.string(), z.unknown()).optional(),
});
export type TerminalNode = z.infer<typeof TerminalNode>;

export const WorkflowNode = z.discriminatedUnion('kind', [
  AgentNode,
  CapabilityNode,
  RuleNode,
  ParallelNode,
  JoinNode,
  ChildWorkflowNode,
  WaitNode,
  SignalWaitNode,
  BranchNode,
  TerminalNode,
]);
export type WorkflowNode = z.infer<typeof WorkflowNode>;

/* --------------------------- Authored body ----------------------------- */

export const WorkflowDefinitionBody = z.object({
  entry: NodeId,
  nodes: z.record(z.string(), WorkflowNode),
  inputSchemaRef: z.string().optional(),
});
export type WorkflowDefinitionBody = z.infer<typeof WorkflowDefinitionBody>;

export const WorkflowDefinition = z.object({
  definitionId: DefinitionId,
  kind: z.literal('workflow'),
  version: SemVer,
  body: WorkflowDefinitionBody,
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

/* ------------------------ Compiled plan (data) ------------------------- */

/** Immutable, content-hashed. Extends CompiledPlanBase. Walked by the single interpreter. */
export const CompiledWorkflowPlan = CompiledPlanBase.extend({
  kind: z.literal('workflow'),
  entry: NodeId,
  graph: z.record(z.string(), WorkflowNode),
  /** Static adjacency for replay/lint (derived, redundant, cheap). */
  edges: z.array(z.object({from: NodeId, to: NodeId})),
});
export type CompiledWorkflowPlan = z.infer<typeof CompiledWorkflowPlan>;

/* ---------------------- Start / result contracts ----------------------- */

export const PlanRef = z.object({
  workflowDefinitionId: DefinitionId,
  planId: PlanId,
  contentHash: ContentHash,
  version: SemVer,
});
export type PlanRef = z.infer<typeof PlanRef>;

/** Temporal start payload — refs + workspace only, NEVER the full plan (ADR-014). */
export const WorkflowExecutionInput = z.object({
  deploymentRef: DeploymentRef,
  planRef: PlanRef,
  workspace: WorkspaceContext,
  input: z.record(z.string(), z.unknown()).default({}),
});
export type WorkflowExecutionInput = z.infer<typeof WorkflowExecutionInput>;

export const WorkflowExecutionResult = z.object({
  workflowRunId: z.string().min(1),
  outcome: z.enum(['completed', 'handoff', 'abandoned', 'failed']),
  terminalNode: NodeId,
  output: z.record(z.string(), z.unknown()).default({}),
  startedAt: IsoTimestamp,
  finishedAt: IsoTimestamp,
});
export type WorkflowExecutionResult = z.infer<typeof WorkflowExecutionResult>;

/* ---------------------------- Runtime port ----------------------------- */

/** The single interpreter's surface (executeCompiledWorkflow). Bound behind a port. */
export interface WorkflowRuntime {
  /** Load + verify the pinned plan once (via a Temporal activity). */
  loadPlan(ref: PlanRef): Promise<CompiledWorkflowPlan>;
  /** Advance one node; returns the next node id or a terminal. Pure over provided state. */
  step(
    plan: CompiledWorkflowPlan,
    nodeId: NodeId,
    ctx: WorkflowExecutionInput,
  ): Promise<{next: NodeId} | {terminal: TerminalNode}>;
}
