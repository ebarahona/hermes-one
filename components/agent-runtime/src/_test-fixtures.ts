// Shared test fixtures for the agent-runtime specs: a valid serializable TurnRequest and a fake
// single-step model. Not a spec file (won't be collected as tests).
import type {
  ModelResult,
  SingleStepModel,
} from '@platform-internal/model-client';
import type {IsoTimestamp, TurnRequest} from '@platform/contracts';

export const FIXED_NOW = '2026-07-11T15:04:00.000Z' as IsoTimestamp;

export const noUsage = {inputTokens: 0, outputTokens: 0, costUsd: 0};

export function fakeModel(...results: ModelResult[]): SingleStepModel {
  let i = 0;
  return {complete: async () => results[Math.min(i++, results.length - 1)]};
}

/** A minimal but contract-valid TurnRequest (full WorkspaceContext). Override the objective/inbound. */
export function testTurnRequest(
  objective = 'Help the customer.',
  inbound: TurnRequest['inbound'] = {attachments: []},
): TurnRequest {
  return {
    turnId: 'trn_test1',
    workspace: {
      workspaceId: 'wsp_test',
      tenantRuntime: {
        tenant: {
          tenantId: 'tnt_test',
          slug: 'test-tenant',
          displayName: 'Test Tenant',
          status: 'active',
          dataResidency: 'us',
          features: {},
          createdAt: FIXED_NOW,
        },
        tenantId: 'tnt_test',
        deployment: {deploymentId: 'dpl_test', tenantId: 'tnt_test', version: '1.0.0'},
        quotaProfile: {
          profileId: 'qp_test',
          maxModelCostUsdPerDay: null,
          maxTokensPerDay: null,
          maxTurnsPerConversation: null,
          maxMessagesPerDay: null,
        },
        budgets: {
          maxSteps: 4,
          deadlineMs: 120_000,
          maxInputTokens: 8000,
          maxOutputTokens: 2000,
          maxModelCostUsd: 1,
        },
        locale: 'en-US',
        timezone: 'UTC',
        operatorRegistryVersion: '1.0.0',
      },
      principal: {
        id: 'prn_test',
        tenantId: 'tnt_test',
        kind: 'user',
        roles: ['customer'],
        scopes: ['appointment.slot.read', 'messaging.reply.send'],
        attributes: {},
      },
      conversationId: 'cnv_test',
      channel: 'sms',
      correlationId: 'corr_test',
    },
    agentEngine: {definitionId: 'def_engine', version: '1.0.0', contentHash: `sha256:${'0'.repeat(64)}`},
    inbound,
    objective,
    startedAt: '2026-07-17T00:00:00.000Z',
  } as TurnRequest;
}
