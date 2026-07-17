// Proves the eval substrate runs the REAL single-step turn loop (runTurn) against injected mocks, captures
// the ledger (dryRun, never persisted), and the runner scores a golden case end-to-end over it.
import {describe, expect, it} from 'vitest';
import type {Decider} from '@platform-internal/agent-runtime';
import type {IsoTimestamp, SemVer, TenantId, ToolCall, ToolResult, TurnRequest} from '@platform/contracts';
import {TurnSimulationService, type TurnSimulationDeps} from './simulation.js';
import {DefaultEvaluationRunner, type SimulateTurnFn} from './runner.js';

const NOW = '2026-07-13T00:00:00.000Z' as IsoTimestamp;

/** A minimal contract-valid TurnRequest (runTurn parses it at the boundary). */
function turnRequest(): TurnRequest {
  return {
    turnId: 'trn_sim',
    startedAt: NOW,
    workspace: {
      workspaceId: 'wsp_sim',
      tenantRuntime: {
        tenant: {tenantId: 'tnt_sim', slug: 'sim-tenant', displayName: 'Sim', status: 'active', dataResidency: 'us', features: {}, createdAt: NOW},
        tenantId: 'tnt_sim' as TenantId,
        deployment: {deploymentId: 'dpl_sim', tenantId: 'tnt_sim', version: '1.0.0'},
        quotaProfile: {profileId: 'qp', maxModelCostUsdPerDay: null, maxTokensPerDay: null, maxTurnsPerConversation: null, maxMessagesPerDay: null},
        budgets: {maxSteps: 4, deadlineMs: 120000, maxInputTokens: 8000, maxOutputTokens: 2000, maxModelCostUsd: 1},
        locale: 'en-US', timezone: 'UTC', operatorRegistryVersion: '1.0.0',
      },
      principal: {id: 'prn_sim', tenantId: 'tnt_sim', kind: 'user', roles: ['customer'], scopes: ['appointment.slot.read'], attributes: {}},
      conversationId: 'cnv_sim', channel: 'sms', correlationId: 'trn_sim',
    },
    agentEngine: {definitionId: 'def_eng', version: '1.0.0' as SemVer, contentHash: `sha256:${'0'.repeat(64)}`},
    inbound: {attachments: []},
    objective: 'book a slot',
  } as unknown as TurnRequest;
}

const call: ToolCall = {
  toolCallId: 'tc_sim' as ToolCall['toolCallId'], capability: 'appointment.slot.read' as ToolCall['capability'],
  input: {date: '2026-07-14'}, idempotencyKey: 'idem', proposedAt: NOW,
};

/** Scripted model: step 0 proposes the tool, step 1 finishes with a reply. */
const decider: Decider = {
  propose: step => step === 0
    ? {kind: 'tool', call, usage: {inputTokens: 10, outputTokens: 5, costUsd: 0}}
    : {kind: 'done', reply: 'You are booked for 9am.', usage: {inputTokens: 4, outputTokens: 6, costUsd: 0}},
};

/** Mock executor: returns a successful ToolResult with one evidence record — no real side effect. */
const executor = {
  dispatch: async (c: ToolCall): Promise<{result: ToolResult}> => ({
    result: {
      toolCallId: c.toolCallId, capability: c.capability, ok: true, output: {slots: ['9am']},
      sideEffect: 'read', stateChanged: false, changedDomains: ['none'],
      evidence: [{id: 'evd_sim', turnId: 'trn_sim', toolCallId: c.toolCallId, kind: 'tool-output', capability: c.capability, statement: 'slots available: 9am', data: {}, source: 'provider', trusted: false, observedAt: NOW}],
      metrics: {latencyMs: 3, providerId: 'mock', retries: 0, costUsd: 0, idempotentReplay: false}, error: null,
    } as unknown as ToolResult,
  }),
} as unknown as TurnSimulationDeps['executor'];

describe('TurnSimulationService', () => {
  it('runs the real turn loop against mocks, captures the ledger, never persists', async () => {
    const sim = new TurnSimulationService();
    const {result, ledger} = await sim.simulateTurn(turnRequest(), {executor, decider});
    expect(result.outcome).toBe('replied');
    expect(result.reply).toContain('9am');
    expect(result.toolCalls.map(c => c.capability)).toContain('appointment.slot.read');
    expect(ledger.evidence.some(e => /9am/.test(e.statement))).toBe(true);
    expect(ledger.toolExecutions).toHaveLength(1);
  });

  it('scores a golden case end-to-end over the real turn (evaluation runner)', async () => {
    const sim = new TurnSimulationService();
    const simulate: SimulateTurnFn = () => sim.simulateTurn(turnRequest(), {executor, decider});
    const runner = new DefaultEvaluationRunner(simulate, () => new Date(NOW));
    const r = await runner.runCase(
      {
        caseId: 'eval_book', tenantId: null, vertical: null, name: 'booking', severity: 'required',
        turns: [{text: 'book me for 9am', attachments: []}],
        assertions: [
          {kind: 'tool-called', capability: 'appointment.slot.read', atStepOrLater: 0},
          {kind: 'evidence-contains', pattern: '9am'},
          {kind: 'reply-matches', pattern: 'booked'},
          {kind: 'turn-outcome', outcome: 'replied'},
        ],
        version: '1.0.0' as SemVer, updatedAt: NOW, updatedBy: 'prn_author',
      },
      {deploymentId: 'dpl_sim' as import('@platform/contracts').DeploymentRef['deploymentId'], tenantId: 'tnt_sim' as TenantId, version: '1.0.0' as SemVer},
    );
    expect(r.passed).toBe(true);
    expect(r.assertionResults.every(a => a.passed)).toBe(true);
  });
});
