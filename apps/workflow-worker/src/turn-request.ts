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
  /**
   * The conversation this turn acts within — minted at the ingest edge (`cnv_<short(from)>`) with the
   * persisted inbound message and threaded through the workflow input. Null ONLY for genuinely
   * conversation-less starts: a handoff outcome with a null conversationId persists NO durable
   * handoff_tasks row (conversation_id is NOT NULL), so the live path must always carry the real id.
   */
  conversationId: string | null,
  /**
   * Deterministic agent-visit ordinal, maintained IN THE WORKFLOW (replay-stable — same value when
   * Temporal replays the same history). Without it two agent-node visits in one run shared a turnId,
   * so the second turn's tool executions were silently dropped by the unique
   * (tenant_id, idempotency_key) index and its usage deduped away.
   */
  visitSeq: number,
  /** Workflow-clock timestamp (deterministic on replay) — the turn's durable rows derive from THIS. */
  startedAt: string,
): TurnRequest {
  const turnId = `trn_${correlationId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}_${visitSeq}`;
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
        deployment: {
          deploymentId: deployment.deploymentId,
          tenantId,
          version: deployment.version,
        },
        quotaProfile: {
          profileId: 'qp_demo',
          maxModelCostUsdPerDay: null,
          maxTokensPerDay: null,
          maxTurnsPerConversation: null,
          maxMessagesPerDay: null,
        },
        // Interim PLATFORM DEFAULTS pending the tenant-config store (ledger S0): budget enforcement is
        // live (A8), so these are generous bounds that only catch runaway turns — a production-sized
        // persona must not fail turns on demo-sized ceilings.
        budgets: {
          maxSteps: 3,
          deadlineMs: 120_000,
          maxInputTokens: 32_000,
          maxOutputTokens: 8000,
          maxModelCostUsd: 5,
        },
        locale: 'en-US',
        timezone: 'UTC',
        operatorRegistryVersion: '1.0.0',
      },
      principal,
      conversationId,
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
    startedAt,
  } as unknown as TurnRequest;
}
