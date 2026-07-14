// Builds the serializable TurnRequest the workflow hands to the agent-plane turn activity (ADR-017).
// Pure/sandbox-safe: no I/O, no clock, no zod — the activity validates via TurnRequest.parse. The
// deployment pin is REAL (D1) and the PRINCIPAL is REAL (AUTH-2): the edge mints it and resolves its
// scopes from roles per request (RoleRegistry) — no demo identity literals remain on the live path.
// Demo scaffolding remains ONLY for the tenant profile/quota/budgets (tenant-configuration store, not
// auth — flagged).
import type {PinnedRef, Principal, TurnRequest} from '@platform/contracts';
import type {DeploymentPin} from './bundle.js';

export function buildAgentTurnRequest(
  tenantId: string,
  deployment: DeploymentPin,
  principal: Principal,
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
      principal,
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
