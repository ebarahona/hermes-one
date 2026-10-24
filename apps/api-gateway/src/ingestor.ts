// InboundIngestor: turns a verified InboundMessage into a running workflow. It persists the inbound
// message (tenant-scoped, RLS), resolves the tenant's active deployment to get the entry workflow +
// rule plan refs (ADR-014), and starts the Temporal workflow with a serializable ref. The host workflow
// is selected from the compiled entry plan (agent nodes → the agent host, else the deterministic host),
// and the run input is the channel-neutral InboundWorkflowInput (channel, sender, text, and the
// provider metadata the channel transport already normalized). The workflowId is derived from the
// provider message id, so a replayed webhook dedupes at the Temporal level.
//
// Flagged (JIT): rule parameters (serviceZips) come from a demo config here — in production they are
// tenant configuration.
import type {Client} from '@temporalio/client';
import type {CompiledPlanStore} from '@hermes-one/drizzle';
import type {DrizzleMessageRepository} from '@hermes-one/drizzle';
import type {
  CompiledWorkflowPlan,
  InboundMessage,
  InboundWorkflowInput,
  PlanId,
  Principal,
  RoleRegistry,
  TenantId,
} from '@hermes-one/contracts';
import {
  WORKFLOW_QUEUE,
  selectHostWorkflow,
  type WorkflowRunRef,
} from '@hermes-one/workflow-worker';

export interface IngestDeps {
  store: CompiledPlanStore;
  messages: DrizzleMessageRepository;
  /** Role→scope resolution (AUTH-2): the acting principal's scopes come from roles PER REQUEST. */
  roles: RoleRegistry;
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

export async function startFromInbound(
  inbound: InboundMessage,
  deps: IngestDeps,
  edgeTraceparent?: string,
): Promise<StartedWorkflow> {
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
    throw new Error(
      `deployment for ${tenantId} is missing a workflow or rule plan`,
    );
  }
  // Load the compiled entry plan (tenant-scoped, hash-verified, cached) to select the host workflow.
  const workflowPlan = (await deps.store.resolvePlanCached(
    tenantId,
    deployment.workflow.planId as PlanId,
    deployment.workflow.contentHash,
  )) as CompiledWorkflowPlan;

  // Mint the ACTING principal (AUTH-2, docs/design/001-edge-authn-design.md): the customer the
  // conversation acts FOR — distinct from the webhook-source system principal that authenticated the
  // request. Deterministic id from the channel handle; scopes resolved from roles per request (a role
  // edit takes effect on the next inbound). This is what gates the agent's tools downstream.
  const principal: Principal = {
    id: `prn_customer_${short(inbound.from)}` as Principal['id'],
    tenantId,
    kind: 'user',
    roles: ['customer'],
    scopes: await deps.roles.resolveScopes(tenantId, ['customer']),
    attributes: {externalHandle: inbound.from, channel: inbound.channel},
  };

  const input: InboundWorkflowInput = {
    channel: inbound.channel,
    from: inbound.from,
    text: inbound.text,
    meta: inbound.meta,
  };
  const ref: WorkflowRunRef = {
    tenantId,
    workflow: {
      planId: deployment.workflow.planId as PlanId,
      contentHash: deployment.workflow.contentHash,
    },
    rule: {planId: rule.planId as PlanId, contentHash: rule.contentHash},
    // Resolve-active-and-PIN (D1): the run — including any agent turn — replays against this exact
    // deployment version even if a new one is published mid-conversation.
    deployment: {
      deploymentId: deployment.deploymentId,
      version: deployment.version,
    },
    principal,
    // The conversation minted above (and already persisted with the inbound message): threading it
    // onto the run means any agent turn's handoff outcome persists its durable handoff_tasks row
    // (conversation_id NOT NULL — a null here silently drops the human task).
    conversationId,
    // Carry the edge trace context onto the workflow input (OB5) so the run joins the edge trace.
    trace: edgeTraceparent ? {traceparent: edgeTraceparent} : undefined,
    parameters: deps.parametersFor(tenantId),
    input,
  };

  const handle = await deps.client.workflow.start(
    selectHostWorkflow(workflowPlan),
    {
      taskQueue: WORKFLOW_QUEUE,
      workflowId: `inbound-${short(inbound.providerMessageId)}`,
      args: [ref],
    },
  );
  return {
    workflowId: handle.workflowId,
    runId: handle.firstExecutionRunId,
    conversationId,
  };
}
