// executeCompiledWorkflow — the ONE workflow interpreter (ADR-014). It walks a
// compiled plan node-by-node and ROUTES; it never performs I/O itself. Every
// side effect (gather facts, evaluate a rule, invoke a capability, read the
// clock) is delegated to injected `WorkflowEffects`, which in production are
// Temporal activities. Keeping the walk pure over (plan, input, effects) makes
// it deterministic and replay-safe, and lets the slice run without Temporal.
import type {
  CompiledWorkflowPlan,
  IsoTimestamp,
  NodeId,
  PinnedRef,
  RuleFacts,
} from '@platform/contracts';

export class WorkflowError extends Error {}

/**
 * The effect boundary — each method is a Temporal activity in production, so it
 * may be async; the interpreter awaits it (matching how workflow code awaits
 * `proxyActivities`). A sync implementation is also fine (awaiting a value is a
 * no-op), which is what the deterministic-rail tests use.
 */
export interface WorkflowEffects {
  /** Gather the rule node's declared facts from the workflow input (no I/O in operators). */
  gatherFacts(
    spec: Record<string, unknown>,
    input: Record<string, unknown>,
  ): RuleFacts | Promise<RuleFacts>;
  /** Evaluate a pinned rule over facts; returns the routing outcome (ADR-023). */
  evaluateRule(
    rule: PinnedRef,
    facts: RuleFacts,
    now: IsoTimestamp,
  ):
    | {outcome: string; emit?: Record<string, unknown>}
    | Promise<{outcome: string; emit?: Record<string, unknown>}>;
  /** Invoke a provider-neutral capability (the node's idempotent side effect). */
  invokeCapability(
    capability: string,
    input: Record<string, unknown>,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Run a bounded agent turn (agent plane) for an `agent` node. Optional — the
   * deterministic rail never needs it. In production this is the serializable
   * Temporal-activity boundary into agent-worker (ADR-017); the workflow never
   * imports @agentback/* itself.
   */
  runAgentTurn?(
    engine: PinnedRef,
    objective: string,
    input: Record<string, unknown>,
  ):
    | {outcome: string; reply?: string}
    | Promise<{outcome: string; reply?: string}>;
  /** The workflow clock (a fact source; never read inside operators). */
  now(): IsoTimestamp;
}

export interface WorkflowRun {
  input: Record<string, unknown>;
}

export interface WorkflowRunResult {
  outcome: 'completed' | 'handoff' | 'abandoned' | 'failed';
  terminalNode: NodeId;
  output: Record<string, unknown>;
  /** Node ids visited, in order — deterministic trace for replay/audit. */
  path: NodeId[];
}

/** Resolve a capability node's input bindings: `{$input:'key'}` → run input; else literal. */
function resolveBindings(
  spec: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && '$input' in v) {
      out[k] = input[(v as {$input: string}).$input];
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function executeCompiledWorkflow(
  plan: CompiledWorkflowPlan,
  run: WorkflowRun,
  effects: WorkflowEffects,
  opts: {maxSteps?: number} = {},
): Promise<WorkflowRunResult> {
  const maxSteps = opts.maxSteps ?? 256;
  const path: NodeId[] = [];
  let nodeId = plan.entry;

  for (let step = 0; step < maxSteps; step++) {
    const node = plan.graph[nodeId];
    if (!node) throw new WorkflowError(`node '${nodeId}' not in plan graph`);
    path.push(nodeId);

    switch (node.kind) {
      case 'rule': {
        const facts = await effects.gatherFacts(node.facts, run.input);
        const {outcome} = await effects.evaluateRule(
          node.rule,
          facts,
          effects.now(),
        );
        const next = node.routes[outcome] ?? node.routes['default'];
        nodeId = next;
        break;
      }
      case 'capability': {
        await effects.invokeCapability(
          node.capability,
          resolveBindings(node.input, run.input),
        );
        nodeId = node.next;
        break;
      }
      case 'agent': {
        if (!effects.runAgentTurn) {
          throw new WorkflowError(
            `agent node '${node.id}' requires a runAgentTurn effect`,
          );
        }
        // Bounded agent turn across the plane boundary; the model proposes,
        // the runtime disposes — the workflow only routes the outcome.
        await effects.runAgentTurn(node.agentEngine, node.objective, run.input);
        nodeId = node.next;
        break;
      }
      case 'terminal':
        return {
          outcome: node.outcome,
          terminalNode: node.id,
          output: node.result ?? {},
          path,
        };
      default:
        // wait / parallel / join / childWorkflow / branch / signalWait arrive
        // with the Temporal durability wiring; rule/capability/agent/terminal
        // cover the deterministic-or-agent routing thesis.
        throw new WorkflowError(
          `node kind '${node.kind}' is not supported in this build`,
        );
    }
  }
  throw new WorkflowError(`workflow exceeded ${maxSteps} steps (cycle?)`);
}
