// The platform-owned bounded agent turn (ADR-021/019/009/018). One Temporal activity runs this whole
// loop against a serializable TurnRequest and returns a serializable TurnResult:
//
//   propose (single-step model) → pre-gate (policy) → execute (wrap agentback) → synthesize ToolResult
//   → selective refresh (by changedDomains) → compose (evidence-only) → post-gate (policy) → TurnResult
//
// The model never orchestrates: it proposes ONE step; the platform gates, executes, and re-prompts.
// confirm: capabilities surface as a policy `approval` round-trip. The composer may cite only evidence.
import {createHash} from 'node:crypto';
import {
  TurnRequest as TurnRequestSchema,
  TurnResult as TurnResultSchema,
  type CapabilityName,
  type ChangedDomain,
  type CompiledPolicyPlan,
  type ConversationId,
  type EvidenceRecord,
  type HandoffId,
  type HandoffReason,
  type IsoTimestamp,
  type PolicyDecision,
  type PolicyEvaluationContext,
  type PolicyOutcome,
  type PolicyRuntime,
  type PolicySite,
  type Scope,
  type TenantId,
  type ToolCall,
  type ToolResult,
  type TurnContext,
  type TurnId,
  type TurnRequest,
  type TurnResult,
} from '@platform/contracts';
import type {PlatformToolExecutor} from '@platform-internal/tool-executor';
import type {Decider} from './single-step-loop.js';
import {composeEvidenceOnly, type Composer} from './compose.js';

/** One paired proposed-call + its executed result (→ runtime.tool_executions). */
export interface TurnLedgerToolExecution {
  call: ToolCall;
  result: ToolResult;
}

/** One gate/voter decision with its binding site (→ runtime.policy_decisions). */
export interface TurnLedgerPolicyDecision {
  /** Deterministic surrogate id (stable across activity replay). */
  decisionId: string;
  site: PolicySite;
  decision: PolicyDecision;
  capability?: CapabilityName;
}

/**
 * The initial human-handoff request a turn emits when it stops for a human (ADR-012). The turn supplies
 * only what it can ground (reason/summary/evidence/ids); the edge composition fills routing defaults
 * (queue/priority/expiry from HandoffConfig) and the initial 'requested'/'agent' ownership state.
 */
export interface TurnLedgerHandoff {
  handoffId: HandoffId;
  reason: HandoffReason;
  summary: string;
  evidenceSnapshot: EvidenceRecord[];
  triggeringTurnId: TurnId;
  conversationId: ConversationId | null;
}

/**
 * The durable ledger a completed turn emits for persistence. Uses only contract types so the agent
 * plane stays free of any store dependency — the edge composition maps it onto the Drizzle repo
 * (no canonical turn-ledger port spec doc exists; this seam is authored JIT, flagged in Open Questions).
 */
export interface TurnLedger {
  turnId: TurnId;
  tenantId: TenantId;
  correlationId: string;
  toolExecutions: TurnLedgerToolExecution[];
  evidence: EvidenceRecord[];
  policyDecisions: TurnLedgerPolicyDecision[];
  /** Model usage accumulated over the turn (for usage metering / billing). */
  usage: {modelCostUsd: number; inputTokens: number; outputTokens: number; toolCount: number};
  /** Present only when outcome='handoff' — the initial handoff request to persist. */
  handoff?: TurnLedgerHandoff;
}

/** Compiled policy + its runtime, screened at the pre-gate (turn) and post-gate (reply) sites. */
export interface TurnPolicy {
  plan: CompiledPolicyPlan;
  runtime: PolicyRuntime;
}

/** Approve a pending `approval`/`confirm` — a human/policy decision in production. Default: reject. */
export type ApproveFn = (decision: PolicyDecision, call: ToolCall) => boolean | Promise<boolean>;

export interface TurnDeps {
  executor: PlatformToolExecutor;
  decider: Decider;
  policy?: TurnPolicy;
  compose?: Composer;
  approve?: ApproveFn;
  /** Wall-clock (the turn runs in an activity where Date is permitted). Injectable for tests. */
  clock?: {nowMs(): number};
  /**
   * Durable-persistence sink for the turn ledger (tool executions, evidence, policy decisions). Called
   * once at every terminal path, before the TurnResult is returned. The edge composition wires a
   * Drizzle-backed writer; omitted in tests that don't assert persistence. A throw fails the turn
   * (audit is fail-closed; the Temporal activity retries and the idempotent writes collapse).
   */
  onPersist?: (ledger: TurnLedger) => Promise<void>;
}

type Outcome = TurnResult['outcome'];

const PREGATE_STOP: Record<Exclude<PolicyOutcome, 'allow' | 'approval' | 'repair'>, Outcome> = {
  deny: 'failed',
  defer: 'deferred',
  handoff: 'handoff',
};

export async function runTurn(request: TurnRequest, deps: TurnDeps): Promise<TurnResult> {
  const req = TurnRequestSchema.parse(request); // serializable-boundary validation (ADR-017)
  const nowMs = deps.clock?.nowMs ?? (() => Date.now());
  const iso = (ms: number) => new Date(ms).toISOString() as IsoTimestamp;
  const compose = deps.compose ?? composeEvidenceOnly;

  const budgets = req.workspace.tenantRuntime.budgets;
  const startedMs = nowMs();
  const startedAt = iso(startedMs);
  const deadlineMs = startedMs + budgets.deadlineMs;
  const deadlineAt = iso(deadlineMs);
  const principal = req.workspace.principal;

  const tenantId = req.workspace.tenantRuntime.tenantId;
  const correlationId = req.workspace.correlationId;

  const evidence: EvidenceRecord[] = [];
  const dirtyDomains: ChangedDomain[] = [];
  const toolCalls: ToolCall[] = [];
  const results: ToolResult[] = [];
  const policyDecisions: TurnLedgerPolicyDecision[] = [];
  const usage = {modelCostUsd: 0, inputTokens: 0, outputTokens: 0};
  let step = 0;
  let gateDecision: PolicyDecision | null = null;
  let lastText: string | undefined;

  // Deterministic surrogate id for a policy decision — stable across activity replay (no random/clock).
  const recordDecision = (site: PolicySite, decision: PolicyDecision, capability?: CapabilityName) => {
    const seq = policyDecisions.length;
    const decisionId = `pld_${createHash('sha256')
      .update(`${req.turnId}:${seq}:${site}:${decision.policyRuleId}`)
      .digest('hex')
      .slice(0, 24)}`;
    policyDecisions.push({decisionId, site, decision, capability});
  };

  // Pair each executed result with its proposed ToolCall (by id) for the tool-execution ledger.
  const buildToolExecutions = (): TurnLedgerToolExecution[] => {
    const callById = new Map(toolCalls.map(c => [c.toolCallId, c]));
    return results
      .map(result => {
        const call = callById.get(result.toolCallId);
        return call ? {call, result} : null;
      })
      .filter((x): x is TurnLedgerToolExecution => x !== null);
  };

  // The initial handoff request, built from the stopping decision + grounded evidence (ADR-012). A
  // policy/confirm gate → 'policy-required'; anything else the turn couldn't ground → 'agent-uncertain'.
  const buildHandoff = (): TurnLedgerHandoff => {
    const gatedForHuman = gateDecision?.outcome === 'handoff' || gateDecision?.outcome === 'approval';
    const reason: HandoffReason = gatedForHuman ? 'policy-required' : 'agent-uncertain';
    return {
      handoffId: `hof_${createHash('sha256').update(req.turnId).digest('hex').slice(0, 24)}` as HandoffId,
      reason,
      summary: gateDecision?.reason ?? 'Agent handed off to a human',
      evidenceSnapshot: [...evidence],
      triggeringTurnId: req.turnId,
      conversationId: req.workspace.conversationId,
    };
  };

  const ctx = (): TurnContext => ({
    turnId: req.turnId,
    workspace: req.workspace,
    step,
    evidence: [...evidence],
    dirtyDomains: [...dirtyDomains],
    startedAt,
    deadlineAt,
  });

  const policyCtx = (extra: Partial<PolicyEvaluationContext>): PolicyEvaluationContext => ({
    principal,
    facts: {...principal.attributes, ...(extra.facts ?? {})},
    now: iso(nowMs()),
    parameters: {},
    scopes: principal.scopes as Scope[],
    ...extra,
  });

  const finish = async (outcome: Outcome, reply?: string): Promise<TurnResult> => {
    const result = TurnResultSchema.parse({
      turnId: req.turnId,
      outcome,
      reply,
      gateDecision,
      toolCalls,
      evidence,
      steps: step,
      metrics: {
        modelCostUsd: usage.modelCostUsd,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        toolCount: toolCalls.length,
      },
      finishedAt: iso(nowMs()),
    });
    // Durable turn persistence (Tier 2): emit the full ledger at every terminal path.
    if (deps.onPersist) {
      await deps.onPersist({
        turnId: req.turnId,
        tenantId,
        correlationId,
        toolExecutions: buildToolExecutions(),
        evidence,
        policyDecisions,
        usage: {...usage, toolCount: toolCalls.length},
        handoff: outcome === 'handoff' ? buildHandoff() : undefined,
      });
    }
    return result;
  };

  for (; step < budgets.maxSteps; step++) {
    if (nowMs() >= deadlineMs) break;

    const decision = await deps.decider.propose(step, results);
    usage.inputTokens += decision.usage.inputTokens;
    usage.outputTokens += decision.usage.outputTokens;
    usage.modelCostUsd += decision.usage.costUsd;

    if (decision.kind === 'done') {
      lastText = decision.reply;
      break;
    }
    let call = decision.call;

    // PRE-GATE (policy, turn-level, ADR-019): screen the proposed tool call.
    if (deps.policy) {
      const pre = deps.policy.runtime.evaluatePreGates(
        deps.policy.plan,
        policyCtx({capability: call.capability, facts: {capability: call.capability, ...call.input}}),
      );
      recordDecision('preGate', pre, call.capability); // audit every gate evaluation, allow included
      if (pre.outcome !== 'allow') {
        gateDecision = pre;
        if (pre.outcome === 'approval') {
          const approved = deps.approve ? await deps.approve(pre, call) : false;
          if (!approved) return finish('handoff');
        } else {
          return finish(PREGATE_STOP[pre.outcome as keyof typeof PREGATE_STOP]);
        }
      }
    }

    // EXECUTE (wrap agentback dispatch, ADR-018).
    toolCalls.push(call);
    let dispatch = await deps.executor.dispatch(call, ctx());

    // confirm → policy `approval` round-trip (ADR-021/T8): approve, then retry with the token.
    if (dispatch.pendingConfirmation) {
      const approvalDecision: PolicyDecision = {
        outcome: 'approval',
        policyRuleId: '<confirm>',
        reason: 'capability requires confirmation before execution',
        decidedAt: iso(nowMs()),
      };
      recordDecision('preGate', approvalDecision, call.capability);
      const approved = deps.approve ? await deps.approve(approvalDecision, call) : false;
      if (!approved) {
        gateDecision = approvalDecision;
        return finish('handoff');
      }
      call = {...call, input: {...call.input, confirmationToken: dispatch.pendingConfirmation.token}};
      dispatch = await deps.executor.dispatch(call, ctx());
    }

    const result = dispatch.result;
    results.push(result);
    evidence.push(...result.evidence);
    for (const d of result.changedDomains) {
      if (d !== 'none' && !dirtyDomains.includes(d)) dirtyDomains.push(d);
    }
    // SELECTIVE REFRESH by changedDomains would re-read the dirty domains here before composing;
    // no read-back capability is wired in this build, so the hook is a documented no-op.
  }

  // COMPOSE (evidence-only, ADR-009).
  const draft = compose(ctx(), req.objective, lastText);

  // POST-GATE (policy, ADR-019): screen the composed reply.
  if (deps.policy && draft) {
    const post = deps.policy.runtime.evaluatePostGates(
      deps.policy.plan,
      policyCtx({draftReply: draft, facts: {draftReply: draft}}),
    );
    recordDecision('postGate', post);
    if (post.outcome === 'deny') {
      gateDecision = post;
      return finish('failed');
    }
    if (post.outcome === 'repair') {
      gateDecision = post;
      // Bounded repair: re-compose is out of scope for this build; deliver the grounded draft and
      // record the repair decision so the boundary is auditable (flagged).
      return finish('replied', draft);
    }
  }

  if (draft) return finish('replied', draft);
  return finish(results.length ? 'replied' : 'no-action', undefined);
}
