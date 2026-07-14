// InboundIngestor: turns a verified InboundMessage into a running workflow. It persists the inbound
// message (tenant-scoped, RLS), resolves the tenant's active deployment to get the entry workflow +
// rule plan refs (ADR-014), and starts the Temporal workflow with a serializable ref. The workflowId is
// derived from the provider message id, so a replayed webhook dedupes at the Temporal level.
//
// Flagged (JIT): rule parameters (serviceZips) come from a demo config here — in production they are
// tenant configuration; and the demo maps the webhook to the missed-call workflow input.
import type {Client} from '@temporalio/client';
import type {CompiledPlanStore} from '@platform-internal/drizzle';
import type {DrizzleMessageRepository} from '@platform-internal/drizzle';
import type {InboundMessage, PlanId, TenantId} from '@platform/contracts';
import {WORKFLOW_QUEUE, type WorkflowRunRef} from '@platform-internal/workflow-worker';

export interface IngestDeps {
  store: CompiledPlanStore;
  messages: DrizzleMessageRepository;
  client: Client;
  /** Rule parameters per tenant (demo stand-in for tenant configuration). */
  parametersFor: (tenantId: TenantId) => Record<string, unknown>;
  clock?: () => Date;
}

export interface StartedWorkflow {
  workflowId: string;
  runId: string;
  conversationId: string;
}

const short = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

export async function startFromInbound(inbound: InboundMessage, deps: IngestDeps): Promise<StartedWorkflow> {
  const tenantId = inbound.tenantId;
  const at = (deps.clock ?? (() => new Date()))();
  const conversationId = `cnv_${short(inbound.from)}`;

  // Persist the inbound message (idempotent on provider_message_id).
  await deps.messages.appendInbound(
    {
      messageId: `msg_${short(inbound.providerMessageId)}`,
      conversationId,
      channel: inbound.channel,
      body: inbound.text,
      providerMessageId: inbound.providerMessageId,
      status: 'received',
      occurredAt: at,
    },
    {tenantId},
  );

  // Resolve the active deployment → entry workflow + rule plan refs.
  const deployment = await deps.store.resolveActiveDeploymentCached(tenantId);
  const rule = deployment.rules[0];
  if (!deployment.workflow.planId || !rule?.planId) {
    throw new Error(`deployment for ${tenantId} is missing a workflow or rule plan`);
  }

  const meta = inbound.providerMeta as Record<string, unknown>;
  const ref: WorkflowRunRef = {
    tenantId,
    workflow: {planId: deployment.workflow.planId as PlanId, contentHash: deployment.workflow.contentHash},
    rule: {planId: rule.planId as PlanId, contentHash: rule.contentHash},
    // Resolve-active-and-PIN (D1): the run — including any agent turn — replays against this exact
    // deployment version even if a new one is published mid-conversation.
    deployment: {deploymentId: deployment.deploymentId, version: deployment.version},
    parameters: deps.parametersFor(tenantId),
    input: {
      channel: 'voice',
      answered: meta.Answered === true || meta.Answered === 'true',
      zip: meta.Zip,
      from: inbound.from,
    },
  };

  const handle = await deps.client.workflow.start('runMissedCall', {
    taskQueue: WORKFLOW_QUEUE,
    workflowId: `inbound-${short(inbound.providerMessageId)}`,
    args: [ref],
  });
  return {workflowId: handle.workflowId, runId: handle.firstExecutionRunId, conversationId};
}
