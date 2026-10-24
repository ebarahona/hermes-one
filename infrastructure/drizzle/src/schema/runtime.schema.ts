// Runtime read/write tables. Every row is tenant-owned (tenant_id NOT NULL) and RLS-protected
// under the strict tenant-isolation policy.
import {
  pgSchema,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/* NB: message_templates + workflow_executions_projection are appended at the end of this file. */

export const runtime = pgSchema('runtime');

/* ------------------------------------------------------------------ *
 * runtime.conversations
 * ------------------------------------------------------------------ */
export const conversations = runtime.table('conversations', {
  conversationId: text('conversation_id').primaryKey(), // ConversationId 'cnv_...'
  tenantId: text('tenant_id').notNull(),
  channel: text('channel')
    .notNull()
    .$type<'sms' | 'whatsapp' | 'webchat' | 'email' | 'voice' | 'api'>(),
  principalId: text('principal_id'), // FK tenant.users, nullable pre-resolution
  status: text('status')
    .notNull()
    .$type<'active' | 'handoff' | 'closed'>()
    .default('active'),
  openedAt: timestamp('opened_at', {withTimezone: true}).notNull().defaultNow(),
  closedAt: timestamp('closed_at', {withTimezone: true}),
  lastMessageAt: timestamp('last_message_at', {withTimezone: true}),
  metadata: jsonb('metadata').notNull().default({}),
});

/* ------------------------------------------------------------------ *
 * runtime.messages
 * ------------------------------------------------------------------ */
export const messages = runtime.table(
  'messages',
  {
    messageId: text('message_id').primaryKey(), // 'msg_...' (storage-only id, no contract brand)
    tenantId: text('tenant_id').notNull(),
    conversationId: text('conversation_id').notNull(), // FK conversations
    turnId: text('turn_id'), // TurnId, nullable (e.g. inbound before a turn starts)
    direction: text('direction').notNull().$type<'inbound' | 'outbound'>(),
    channel: text('channel')
      .notNull()
      .$type<'sms' | 'whatsapp' | 'webchat' | 'email' | 'voice' | 'api'>(),
    senderPrincipalId: text('sender_principal_id'),
    body: text('body'),
    attachments: jsonb('attachments').notNull().default([]),
    providerMessageId: text('provider_message_id'), // InboundMessage/DeliveryReceipt correlation
    status: text('status')
      .notNull()
      .$type<
        | 'received'
        | 'queued'
        | 'sent'
        | 'delivered'
        | 'read'
        | 'failed'
        | 'undelivered'
      >(),
    occurredAt: timestamp('occurred_at', {withTimezone: true}).notNull(),
    createdAt: timestamp('created_at', {withTimezone: true})
      .notNull()
      .defaultNow(),
  },
  t => ({
    convOccurredIdx: index('messages_conv_occurred_idx').on(
      t.conversationId,
      t.occurredAt,
    ),
    providerMsgUq: uniqueIndex('messages_tenant_provider_msg_uq').on(
      t.tenantId,
      t.providerMessageId,
    ), // partial WHERE provider_message_id IS NOT NULL — inbound idempotency
  }),
);

/* ------------------------------------------------------------------ *
 * runtime.tool_executions — durable replay/audit ledger for side-effecting tool calls.
 * Aligns to ToolCall + ToolResult.
 * ------------------------------------------------------------------ */
export const toolExecutions = runtime.table(
  'tool_executions',
  {
    toolCallId: text('tool_call_id').primaryKey(), // ToolCallId 'tc_...'
    tenantId: text('tenant_id').notNull(),
    turnId: text('turn_id').notNull(),
    capabilityName: text('capability_name').notNull(),
    input: jsonb('input').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    ok: boolean('ok').notNull(),
    output: jsonb('output'),
    sideEffect: text('side_effect')
      .notNull()
      .$type<'none' | 'read' | 'write' | 'external' | 'payment'>(),
    stateChanged: boolean('state_changed').notNull().default(false),
    changedDomains: text('changed_domains').array().notNull().default([]),
    metrics: jsonb('metrics').notNull(), // ToolMetrics
    error: jsonb('error'), // {code, message, retryable} | null
    proposedAt: timestamp('proposed_at', {withTimezone: true}).notNull(),
    executedAt: timestamp('executed_at', {withTimezone: true})
      .notNull()
      .defaultNow(),
  },
  t => ({
    tenantTurnIdx: index('te_tenant_turn_idx').on(t.tenantId, t.turnId),
    idempotencyUq: uniqueIndex('te_tenant_idempotency_uq').on(
      t.tenantId,
      t.idempotencyKey,
    ),
  }),
);

/* ------------------------------------------------------------------ *
 * runtime.evidence_records — grounded, citable facts (evidence-only composition, ADR-009).
 * Aligns column-for-column to EvidenceRecord.
 * ------------------------------------------------------------------ */
export const evidenceRecords = runtime.table(
  'evidence_records',
  {
    id: text('id').primaryKey(), // EvidenceId 'evd_...'
    tenantId: text('tenant_id').notNull(),
    turnId: text('turn_id').notNull(),
    toolCallId: text('tool_call_id'), // FK tool_executions, nullable
    kind: text('kind')
      .notNull()
      .$type<'tool-output' | 'authoritative-read' | 'retrieval' | 'system'>(),
    capabilityName: text('capability_name'),
    statement: text('statement').notNull(),
    data: jsonb('data').notNull(),
    source: text('source')
      .notNull()
      .$type<'authoritative' | 'provider' | 'retrieved' | 'system'>(),
    trusted: boolean('trusted').notNull(),
    observedAt: timestamp('observed_at', {withTimezone: true}).notNull(),
  },
  t => ({
    tenantTurnIdx: index('evd_tenant_turn_idx').on(t.tenantId, t.turnId),
  }),
);

/* ------------------------------------------------------------------ *
 * runtime.policy_decisions — every gate/voter decision for a turn (audit + explainability).
 * Aligns to PolicyDecision + PolicySite.
 * decision_id is a storage-only surrogate (the contract carries no persistence id).
 * ------------------------------------------------------------------ */
export const policyDecisions = runtime.table(
  'policy_decisions',
  {
    decisionId: text('decision_id').primaryKey(), // 'pld_...', storage-only
    tenantId: text('tenant_id').notNull(),
    turnId: text('turn_id'),
    correlationId: text('correlation_id').notNull(),
    site: text('site').notNull().$type<'voter' | 'preGate' | 'postGate'>(),
    policyRuleId: text('policy_rule_id').notNull(),
    outcome: text('outcome')
      .notNull()
      .$type<'allow' | 'deny' | 'defer' | 'repair' | 'handoff' | 'approval'>(),
    reason: text('reason').notNull(),
    detail: jsonb('detail'),
    capabilityName: text('capability_name'), // present only at voter site
    decidedAt: timestamp('decided_at', {withTimezone: true}).notNull(),
  },
  t => ({
    tenantTurnIdx: index('pld_tenant_turn_idx').on(t.tenantId, t.turnId),
    tenantDecidedIdx: index('pld_tenant_decided_idx').on(
      t.tenantId,
      t.decidedAt,
    ),
  }),
);

/* ------------------------------------------------------------------ *
 * runtime.handoff_tasks — durable human-handoff request + ownership state (ADR-012).
 * Aligns to HandoffRequest + HandoffState merged.
 * ------------------------------------------------------------------ */
export const handoffTasks = runtime.table(
  'handoff_tasks',
  {
    handoffId: text('handoff_id').primaryKey(), // HandoffId 'hof_...'
    tenantId: text('tenant_id').notNull(),
    conversationId: text('conversation_id').notNull(), // FK conversations
    triggeringTurnId: text('triggering_turn_id'),
    reason: text('reason')
      .notNull()
      .$type<
        | 'policy-required'
        | 'agent-uncertain'
        | 'customer-requested'
        | 'error-escalation'
        | 'high-value'
      >(),
    priority: text('priority')
      .notNull()
      .$type<'low' | 'normal' | 'high' | 'urgent'>(),
    summary: text('summary').notNull(),
    evidenceSnapshot: jsonb('evidence_snapshot').notNull().default([]), // EvidenceRecord[]
    queue: text('queue').notNull(),
    operatorId: text('operator_id'), // FK tenant.users
    status: text('status')
      .notNull()
      .$type<
        | 'requested'
        | 'assigned'
        | 'human_owned'
        | 'resolved'
        | 'returned'
        | 'expired'
      >(),
    owner: text('owner').notNull().$type<'agent' | 'human'>(),
    transitions: jsonb('transitions').notNull().default([]), // append-only HandoffState.transitions
    requestedAt: timestamp('requested_at', {withTimezone: true}).notNull(),
    expiresAt: timestamp('expires_at', {withTimezone: true}),
    updatedAt: timestamp('updated_at', {withTimezone: true})
      .notNull()
      .defaultNow(),
  },
  t => ({
    tenantStatusIdx: index('ho_tenant_status_idx').on(t.tenantId, t.status),
    queueStatusIdx: index('ho_queue_status_idx').on(t.queue, t.status),
    conversationIdx: index('ho_conversation_idx').on(t.conversationId),
  }),
);

/* ------------------------------------------------------------------ *
 * runtime.message_templates — reusable outbound message templates. tenant_id IS NULL = platform template.
 * Aligns to OutboundMessage.templateId.
 * ------------------------------------------------------------------ */
export const messageTemplates = runtime.table(
  'message_templates',
  {
    templateId: text('template_id').primaryKey(), // 'tpl_...'
    tenantId: text('tenant_id'), // NULL = platform template
    channel: text('channel')
      .notNull()
      .$type<'sms' | 'whatsapp' | 'webchat' | 'email' | 'voice'>(),
    name: text('name').notNull(),
    providerTemplateId: text('provider_template_id'), // e.g. WhatsApp-registered template id
    body: text('body').notNull(),
    variables: jsonb('variables').notNull().default({}),
    locale: text('locale').notNull().default('en-US'),
    status: text('status')
      .notNull()
      .$type<'draft' | 'active' | 'retired'>()
      .default('draft'),
    createdAt: timestamp('created_at', {withTimezone: true})
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', {withTimezone: true})
      .notNull()
      .defaultNow(),
  },
  t => ({
    tenantChannelNameUq: uniqueIndex('mt_tenant_channel_name_uq').on(
      t.tenantId,
      t.channel,
      t.name,
    ),
  }),
);

/* ------------------------------------------------------------------ *
 * runtime.workflow_executions_projection — Postgres read-model of Temporal workflow executions (Temporal
 * remains the source of truth; this exists for tenant-scoped admin/API querying).
 * Aligns to WorkflowExecutionInput/Result + DeploymentRef/PlanRef.
 * ------------------------------------------------------------------ */
export const workflowExecutionsProjection = runtime.table(
  'workflow_executions_projection',
  {
    workflowRunId: text('workflow_run_id').primaryKey(), // Temporal runId (external, unprefixed)
    workflowId: text('workflow_id').notNull(), // Temporal deterministic WorkflowId
    tenantId: text('tenant_id').notNull(),
    deploymentId: text('deployment_id').notNull(),
    deploymentVersion: text('deployment_version').notNull(),
    planId: text('plan_id').notNull(),
    workspaceId: text('workspace_id'), // FK tenant.workspaces
    conversationId: text('conversation_id'), // FK runtime.conversations
    status: text('status')
      .notNull()
      .$type<
        | 'running'
        | 'completed'
        | 'handoff'
        | 'abandoned'
        | 'failed'
        | 'terminated'
        | 'continued_as_new'
      >(),
    currentNodeId: text('current_node_id'),
    outcome: jsonb('outcome'),
    correlationId: text('correlation_id').notNull(),
    startedAt: timestamp('started_at', {withTimezone: true}).notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true})
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', {withTimezone: true}),
  },
  t => ({
    tenantStatusIdx: index('wep_tenant_status_idx').on(t.tenantId, t.status),
    tenantWorkflowIdIdx: index('wep_tenant_workflow_id_idx').on(
      t.tenantId,
      t.workflowId,
    ),
    conversationIdx: index('wep_conversation_idx').on(t.conversationId),
  }),
);
