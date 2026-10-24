// Support-ticket triage vertical — LIVE run on real Temporal + a live LLM (MANUAL GATE, not CI: needs
// an OpenAI-compatible endpoint, see README "LLM configuration"). Installs the support vertical FROM
// DATA (verticals/support/pack.json) for a demo tenant with the same generic installer the electrician
// pack uses, then drives real inbound runs through the generic workflow interpreter host
// (runAgentWorkflow) with the channel-neutral InboundWorkflowInput the ingest edge builds.
//
// THREE CASES, one per routing class of the support-triage rule:
//   1. password reset — answered by a deterministic templated reply (messaging.reply.send); the
//                       workflow never reaches the agent node, so no model call is made.
//   2. outage report  — escalated deterministically: a templated notice, then the `handoff` terminal.
//                       Again no agent node, no model call.
//   3. judgment       — matches no rule term, so the rule routes to the bounded support agent and a
//                       real LLM turn runs against the support engine (persona + reply policy).
// Each case is asserted on the workflow path and outcome AND on the durable audit timeline: the
// `decision.rule` event records the rule's outcome, and the deterministic cases carry no turn-scoped
// rows (an agent turn always writes its ledger under a turnId). Every case also delivers exactly one
// reply on the customer's channel — the templated reply, the escalation notice, or the agent's
// post-gated reply — asserted as one durable outbound runtime.messages row.
//
//   docker compose -f infra/docker-compose.yml up -d   (+ an LLM at LLM_BASE_URL)
//   pnpm -r build && node apps/agent-worker/dist/support-pack.e2e.js
import {Client, Connection} from '@temporalio/client';
import {Pool} from 'pg';
import {loadConfig} from '@hermes-one/config';
import {createAuditQueryService, createRoleRegistry} from '@hermes-one/drizzle';
import {
  createWorkflowWorker,
  installVerticalPack,
  WORKFLOW_QUEUE,
} from '@hermes-one/workflow-worker';
import {createActivityWorker} from '@hermes-one/activity-worker';
import type {
  AuditEvent,
  InboundWorkflowInput,
  Principal,
  TenantId,
} from '@hermes-one/contracts';
import {createAgentWorker} from './worker.js';

const TENANT = 'tnt_support_demo';
const SUPPORT_PACK = 'verticals/support/pack.json';
const FROM = '+15125550100';

/** Outbound runtime.messages bodies for the tenant since `since` (tenant-scoped read under RLS). */
async function outboundSince(pool: Pool, since: Date): Promise<string[]> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
    const {rows} = await c.query<{body: string | null}>(
      `SELECT body FROM runtime.messages
        WHERE tenant_id = $1 AND direction = 'outbound' AND occurred_at >= $2
        ORDER BY occurred_at`,
      [TENANT, since],
    );
    await c.query('COMMIT');
    return rows.map(r => r.body ?? '');
  } finally {
    c.release();
  }
}

interface Case {
  name: string;
  text: string;
  /** The support-triage rule outcome this message must produce. */
  ruleOutcome: string;
  path: string[];
  outcome: 'completed' | 'handoff';
  /** Whether the run may reach the agent node (and therefore the LLM). */
  agentTurn: boolean;
}

const CASES: Case[] = [
  {
    name: 'password reset → templated reply, no model call',
    text: 'Hi, I forgot my Password and cannot get back into my account.',
    ruleOutcome: 'password-reset',
    path: ['triage', 'password_reset', 'end'],
    outcome: 'completed',
    agentTurn: false,
  },
  {
    name: 'outage report → deterministic escalation, no model call',
    text: 'URGENT: the dashboard is down for our whole team.',
    ruleOutcome: 'escalate',
    path: ['triage', 'escalation_notice', 'escalate'],
    outcome: 'handoff',
    agentTurn: false,
  },
  {
    name: 'needs judgment → bounded agent turn on the live LLM',
    text: 'We are a team of twelve and mostly use the reporting features. Which plan would fit us best?',
    ruleOutcome: 'needs-judgment',
    path: ['triage', 'assist', 'end'],
    outcome: 'completed',
    agentTurn: true,
  },
];

async function main(): Promise<void> {
  const cfg = loadConfig();

  // 1. Install the support vertical from data — the generic installer, given only the pack path.
  const install = await installVerticalPack(
    cfg.stores.authoritative.url,
    cfg.stores.ephemeral.url,
    TENANT,
    SUPPORT_PACK,
  );
  console.log(
    `[support-pack] installed support deployment ${install.deployment.deploymentId} (v${install.deployment.version}) for ${TENANT}`,
  );

  const connection = await Connection.connect({address: cfg.temporal.address});
  const client = new Client({connection, namespace: cfg.temporal.namespace});
  const workflowWorker = await createWorkflowWorker();
  const activityWorker = await createActivityWorker();
  const agentWorker = await createAgentWorker();

  // 2. The acting caller — a customer, minted as the ingest edge mints it: scopes resolved from roles.
  const {repo: roleRegistry, close: closeRoles} = createRoleRegistry(
    cfg.stores.authoritative.url,
  );
  const principal: Principal = {
    id: 'prn_support_customer' as Principal['id'],
    tenantId: TENANT as Principal['tenantId'],
    kind: 'user',
    roles: ['customer'],
    scopes: await roleRegistry.resolveScopes(TENANT as Principal['tenantId'], [
      'customer',
    ]),
    attributes: {externalHandle: FROM, channel: 'sms'},
  };
  await closeRoles();

  const {repo: audit, close: closeAudit} = createAuditQueryService(
    cfg.stores.authoritative.url,
  );
  const pg = new Pool({connectionString: cfg.stores.authoritative.url, max: 1});
  const results: {name: string; pass: boolean; detail: string}[] = [];

  const clientWork = (async () => {
    for (const [i, c] of CASES.entries()) {
      const correlationId = `support-pack-${Date.now()}-${i}`;
      const startedAt = new Date();
      const input: InboundWorkflowInput = {
        channel: 'sms',
        from: FROM,
        text: c.text,
        meta: {},
      };
      const handle = await client.workflow.start('runAgentWorkflow', {
        taskQueue: WORKFLOW_QUEUE,
        workflowId: correlationId,
        args: [
          {
            tenantId: TENANT,
            workflow: install.workflow,
            rule: install.rule,
            deployment: install.deployment,
            principal,
            // Mirrors the ingest edge's minting (`cnv_<short(from)>`).
            conversationId: 'cnv_15125550100',
            parameters: install.parameters,
            input,
          },
        ],
      });
      const out = (await handle.result()) as {path: string[]; outcome: string};

      const timeline = await audit.composeTimeline(
        TENANT as TenantId,
        correlationId,
      );
      const decisions = timeline
        .filter(e => e.kind === 'audit' && e.detail !== null)
        .map(e => e.detail as AuditEvent)
        .filter(a => a.action === 'decision.rule')
        .map(a => (a.detail as {outcome?: string}).outcome);
      const turnRows = timeline.filter(e => e.turnId !== null).length;
      // The reply on the customer's channel: one durable outbound row with a non-empty body.
      const outbound = await outboundSince(pg, startedAt);

      const pathOk = JSON.stringify(out.path) === JSON.stringify(c.path);
      const outcomeOk = out.outcome === c.outcome;
      const decisionOk =
        decisions.length === 1 && decisions[0] === c.ruleOutcome;
      const noModelOk = c.agentTurn || turnRows === 0;
      const deliveredOk = outbound.length === 1 && outbound[0]!.length > 0;
      results.push({
        name: c.name,
        pass: pathOk && outcomeOk && decisionOk && noModelOk && deliveredOk,
        detail: `path=${JSON.stringify(out.path)} outcome=${out.outcome} decision=${JSON.stringify(decisions)} turnRows=${turnRows} outbound=${outbound.length}`,
      });
    }
  })();

  await Promise.all([
    clientWork,
    workflowWorker.runUntil(clientWork),
    activityWorker.runUntil(clientWork),
    agentWorker.runUntil(clientWork),
  ]);

  await connection.close();
  await closeAudit();
  await pg.end();

  for (const r of results)
    console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}`);
  if (results.some(r => !r.pass) || results.length !== CASES.length) {
    console.error('\nSupport pack live E2E FAILED');
    process.exit(1);
  }
  console.log(
    "\nSupport pack live E2E OK — the support vertical (authored as DATA) answered and escalated by rule with no model call, handed the judgment case to a bounded agent turn on the live LLM, and delivered every reply on the customer's channel.",
  );
  process.exit(0);
}

await main();
