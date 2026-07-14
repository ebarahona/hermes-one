// Builds the serializable TurnRequest the workflow hands to the agent-plane turn activity (ADR-017).
// Pure/sandbox-safe: no I/O, no clock, no zod — the activity validates via TurnRequest.parse. The
// deployment pin is REAL (D1): the edge resolves-active-and-pins at start; the turn resolves that
// exact deployment on replay, never the current active. Demo scaffolding remains for tenant profile +
// principal: a production edge assembles those from the tenant registry + authn (flagged, F1).
import type {PinnedRef, TurnRequest} from '@platform/contracts';
import type {DeploymentPin} from './bundle.js';

export function buildAgentTurnRequest(
  tenantId: string,
  deployment: DeploymentPin,
  engine: PinnedRef,
  objective: string,
  input: Record<string, unknown>,
  correlationId: string,
): TurnRequest {
  const turnId = `trn_${correlationId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;
  return {
    turnId,
    workspace: {
      workspaceId: `wsp_${tenantId}`,
      tenantRuntime: {
        tenant: {
          tenantId,
          slug: 'demo-tenant',
          displayName: 'Demo Tenant',
          status: 'active',
          dataResidency: 'us',
          features: {},
          createdAt: '2026-07-11T00:00:00.000Z',
        },
        tenantId,
        deployment: {deploymentId: deployment.deploymentId, tenantId, version: deployment.version},
        quotaProfile: {
          profileId: 'qp_demo',
          maxModelCostUsdPerDay: null,
          maxTokensPerDay: null,
          maxTurnsPerConversation: null,
          maxMessagesPerDay: null,
        },
        budgets: {
          maxSteps: 3,
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
        id: 'prn_demo',
        tenantId,
        kind: 'user',
        roles: ['customer'],
        scopes: ['appointment.slot.read', 'messaging.reply.send'],
        attributes: {},
      },
      conversationId: null,
      channel: 'sms',
      correlationId,
    },
    agentEngine: {
      definitionId: engine.definitionId,
      version: engine.version,
      contentHash: engine.contentHash,
    },
    inbound: {text: JSON.stringify(input), attachments: []},
    objective,
  } as unknown as TurnRequest;
}
