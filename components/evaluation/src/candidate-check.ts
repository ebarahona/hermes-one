// composeCandidateRegressionCheck (OB6/OB3 follow-on — the REAL regression check
// `DeploymentService.publish` consumes). At gate time the candidate deployment ROW does not exist
// yet, but every MEMBER is already content-addressed in the substrate (DefinitionRegistry.put runs
// before publish) — so the composition takes the candidate's member refs (the same data the caller
// passes to publish), loads the engine/capabilities/policy hash-verified through injected store
// loaders, derives the scope-gated tool set EXACTLY like agent-activity does, and plays the golden
// suite through TurnSimulationService — the ONE turn loop, dryRun, with a SCRIPTED decider and a
// mock provider plane (CI-safe: no model, no vendors; the ToolResult metadata — sideEffect /
// changedDomains — comes from the candidate's OWN contracts, not fixtures).
//
// FLAGGED: the eval principal is granted the engine's full allowed scope set (scope-narrowing cases
// script `tool-not-called` assertions instead); the workflow-level Temporal mock-provider simulation
// (spec `SimulationService.simulateWorkflow`) remains deferred — this is the turn-level cut.
import type {
  AgentEngineContract,
  CapabilityContract,
  CompiledPolicyPlan,
  ContentHash,
  DefinitionId,
  DeploymentRef,
  GoldenConversationCase,
  PlanId,
  PolicyRuntime,
  Scope,
  TenantId,
  ToolCall,
  ToolResult,
  TurnRequest,
} from '@platform/contracts';
import {capabilitiesForEngine} from '@platform/capability-contract';
import type {Decider, DeciderTool, TurnDeps} from '@platform-internal/agent-runtime';
import {TurnSimulationService, type TurnSimulationOutput} from './simulation.js';
import {DefaultEvaluationRunner, DefaultRegressionGate, type SimulateTurnFn} from './runner.js';
import {runBehavioralRegression, type GateResult} from './gate-check.js';

/** The candidate manifest's member refs — mirrors the PublishDeploymentInput the caller builds. */
export interface CandidateMemberRefs {
  tenantId: TenantId;
  agentEngine: {definitionId: DefinitionId; contentHash: ContentHash};
  policy: {planId: PlanId; contentHash: ContentHash};
  capabilities: {definitionId: DefinitionId; contentHash: ContentHash}[];
}

export interface CandidateCheckDeps {
  members: CandidateMemberRefs;
  /** Hash-verified store loaders (CompiledPlanStore.resolveContractCached / resolvePlanCached shape). */
  loadContract(tenantId: TenantId, definitionId: DefinitionId, contentHash: ContentHash): Promise<unknown>;
  loadPlan(tenantId: TenantId, planId: PlanId, contentHash: ContentHash): Promise<unknown>;
  /** The policy runtime evaluating the candidate's compiled plan (ADR-019). Omitted = ungated sim. */
  policyRuntime?: PolicyRuntime;
  /** The golden suite gating this publish. */
  suite: GoldenConversationCase[];
  /** Scripted mock model per case — the "model proposes" side of the simulation. */
  script(goldenCase: GoldenConversationCase, tools: DeciderTool[]): Decider;
  /** Mock provider plane: the unwrapped output a capability returns in simulation. */
  toolOutput?(capability: string, input: Record<string, unknown>): unknown;
}

const NOW = '2026-01-01T00:00:00.000Z';

/** Mock executor synthesizing ToolResults from the candidate's OWN contracts (no real dispatch). */
function mockExecutor(
  byName: Map<string, CapabilityContract>,
  toolOutput: NonNullable<CandidateCheckDeps['toolOutput']>,
): TurnDeps['executor'] {
  return {
    dispatch: async (call: ToolCall) => {
      const contract = byName.get(call.capability);
      const output = toolOutput(call.capability, call.input);
      return {
        result: {
          toolCallId: call.toolCallId,
          capability: call.capability,
          ok: true,
          output,
          sideEffect: contract?.sideEffect ?? 'read',
          stateChanged: contract ? contract.sideEffect !== 'none' && contract.sideEffect !== 'read' : false,
          changedDomains: contract ? [...contract.changedDomains] : ['none'],
          evidence: [
            {
              id: `evd_sim_${call.toolCallId}`,
              turnId: 'trn_sim',
              toolCallId: call.toolCallId,
              kind: 'tool-output',
              capability: call.capability,
              statement: `simulated ${call.capability}: ${JSON.stringify(output)}`,
              data: {},
              source: 'provider',
              trusted: false,
              observedAt: NOW,
            },
          ],
          metrics: {latencyMs: 1, providerId: 'mock-provider', retries: 0, costUsd: 0, idempotentReplay: false},
          error: null,
        } as unknown as ToolResult,
      };
    },
  } as unknown as TurnDeps['executor'];
}

/** Minimal, contract-valid simulated workspace for one golden turn against the candidate. */
function simTurnRequest(
  tenantId: TenantId,
  candidate: DeploymentRef,
  engineRef: {definitionId: DefinitionId; contentHash: ContentHash},
  scopes: Scope[],
  inbound: {text: string; attachments: {kind: string; ref: string}[]},
  seq: number,
): TurnRequest {
  return {
    turnId: `trn_sim_${candidate.version.replace(/\./g, '')}_${seq}`,
    workspace: {
      workspaceId: `wsp_sim_${tenantId}`,
      tenantRuntime: {
        tenant: {
          tenantId, slug: 'sim-tenant', displayName: 'Simulation', status: 'active',
          dataResidency: 'us', features: {}, createdAt: NOW,
        },
        tenantId,
        deployment: {deploymentId: candidate.deploymentId, tenantId, version: candidate.version},
        quotaProfile: {profileId: 'qp_sim', maxModelCostUsdPerDay: null, maxTokensPerDay: null, maxTurnsPerConversation: null, maxMessagesPerDay: null},
        budgets: {maxSteps: 5, deadlineMs: 30_000, maxInputTokens: 8000, maxOutputTokens: 2000, maxModelCostUsd: 1},
        locale: 'en-US', timezone: 'UTC', operatorRegistryVersion: '1.0.0',
      },
      principal: {id: 'prn_sim_eval', tenantId, kind: 'system', roles: ['eval'], scopes, attributes: {}},
      conversationId: null,
      channel: 'api',
      correlationId: `sim-${candidate.deploymentId}-${seq}`,
    },
    agentEngine: {definitionId: engineRef.definitionId, version: '1.0.0', contentHash: engineRef.contentHash},
    inbound,
    objective: 'golden-case simulation',
  } as unknown as TurnRequest;
}

/**
 * Build the `regressionCheck` DeploymentService.publish consumes: loads the CANDIDATE's own
 * engine/capabilities/policy, then plays the golden suite through the real turn loop against the
 * mock provider plane, gating on required-severity failures.
 */
export function composeCandidateRegressionCheck(
  deps: CandidateCheckDeps,
): (candidate: DeploymentRef) => Promise<GateResult> {
  return async candidate => {
    const {members} = deps;
    const engine = (await deps.loadContract(
      members.tenantId, members.agentEngine.definitionId, members.agentEngine.contentHash,
    )) as AgentEngineContract;
    const contracts = (await Promise.all(
      members.capabilities.map(c => deps.loadContract(members.tenantId, c.definitionId, c.contentHash)),
    )) as CapabilityContract[];
    const policyPlan = (await deps.loadPlan(
      members.tenantId, members.policy.planId, members.policy.contentHash,
    )) as CompiledPolicyPlan;

    // The eval principal carries the full allowed scope set (flagged above).
    const scopes = contracts.map(c => c.requiredScope);
    const tools: DeciderTool[] = capabilitiesForEngine(engine.body.allowedCapabilities, contracts, scopes).map(c => ({
      toolName: c.name.replace(/\./g, '_'),
      capability: c.name,
      description: c.description,
      parameters: c.inputJsonSchema,
    }));
    const byName = new Map(contracts.map(c => [c.name as string, c]));
    const executor = mockExecutor(byName, deps.toolOutput ?? (() => ({})));
    const sim = new TurnSimulationService();

    // Per-case scripted decider — rebuilt per simulate call so multi-turn scripts restart cleanly.
    const simulateFor = (goldenCase: GoldenConversationCase): SimulateTurnFn => {
      let seq = 0;
      return async (inbound, ref) => {
        const out: TurnSimulationOutput = await sim.simulateTurn(
          simTurnRequest(members.tenantId, ref, members.agentEngine, scopes, inbound, seq++),
          {
            executor,
            decider: deps.script(goldenCase, tools),
            policy: deps.policyRuntime ? {plan: policyPlan, runtime: deps.policyRuntime} : undefined,
          },
        );
        return out;
      };
    };

    const gate = new DefaultRegressionGate();
    const results: GateResult[] = [];
    for (const goldenCase of deps.suite) {
      const runner = new DefaultEvaluationRunner(simulateFor(goldenCase));
      results.push(await runBehavioralRegression(runner, gate, [goldenCase], candidate));
    }
    const failed = results.filter(r => !r.pass);
    return failed.length === 0
      ? {pass: true}
      : {
          pass: false,
          reason: failed.map(f => f.reason ?? 'gate failed').join('; '),
          failedCaseIds: failed.flatMap(f => f.failedCaseIds ?? []),
        };
  };
}
