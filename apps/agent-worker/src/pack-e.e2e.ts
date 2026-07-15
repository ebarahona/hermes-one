// Pack E — LIVE electrician turn on real Temporal + the local LLM (MANUAL GATE, not CI: needs
// llama-server at :8080). Installs the electrician vertical FROM DATA (verticals/electrician/pack.json)
// for a demo tenant, then drives a real inbound turn: the generic workflow interpreter host (runTriage)
// interprets the electrician-intake workflow → the electrician-triage rule routes to the dispatcher
// agent node → a REAL bounded agent turn runs against the electrician engine (persona + policy) and the
// live LLM → the workflow completes. Proves the platform runs a real vertical, authored purely as data,
// end-to-end on durable infrastructure.
//
//   docker compose -f infra/docker-compose.yml up -d   (+ llama-server at :8080)
//   pnpm -r build && node apps/agent-worker/dist/pack-e.e2e.js
import {Client, Connection} from '@temporalio/client';
import {loadConfig} from '@platform-internal/config';
import {createWorkflowWorker, installElectricianPack, WORKFLOW_QUEUE} from '@platform-internal/workflow-worker';
import {createActivityWorker} from '@platform-internal/activity-worker';
import type {Principal} from '@platform/contracts';
import {createAgentWorker} from './worker.js';

const TENANT = 'tnt_elec_demo';

async function main(): Promise<void> {
  const cfg = loadConfig();

  // 1. Install the electrician vertical from data (author the 5 defs + publish the deployment) —
  //    exactly what the admin API does, headless. Returns the plan refs + the pinned deployment.
  const install = await installElectricianPack(cfg.stores.authoritative.url, cfg.stores.ephemeral.url, TENANT);
  console.log(`[pack-e] installed electrician deployment ${install.deployment.deploymentId} (v${install.deployment.version}) for ${TENANT}`);

  const connection = await Connection.connect({address: cfg.temporal.address});
  const client = new Client({connection, namespace: cfg.temporal.namespace});
  const workflowWorker = await createWorkflowWorker();
  const activityWorker = await createActivityWorker();
  const agentWorker = await createAgentWorker();

  // 2. The acting caller — a customer of the electrician. No tool scopes here, so the dispatcher agent
  //    has no derivable tools and answers from its persona (the tool-backed slot-read is a follow-up
  //    that needs the electrical.slot.read provider — the pack's "new platform capability" exception).
  const principal: Principal = {
    id: 'prn_elec_caller' as Principal['id'],
    tenantId: TENANT as Principal['tenantId'],
    kind: 'user',
    roles: [],
    scopes: [],
    attributes: {externalHandle: '+15125550000', channel: 'sms'},
  };

  const ref = {
    tenantId: TENANT,
    workflow: install.workflow,
    rule: install.rule,
    deployment: install.deployment,
    principal,
    parameters: install.parameters,
    input: {intent: 'my breaker keeps tripping and there is a faint burning smell near the panel'},
  };

  const clientWork = (async () => {
    const handle = await client.workflow.start('runTriage', {
      taskQueue: WORKFLOW_QUEUE,
      workflowId: `pack-e-elec-${Date.now()}`,
      args: [ref],
    });
    return (await handle.result()) as {path: string[]; outcome?: string};
  })();

  const [result] = await Promise.all([
    clientWork,
    workflowWorker.runUntil(clientWork),
    activityWorker.runUntil(clientWork),
    agentWorker.runUntil(clientWork),
  ]);

  await connection.close();

  const expected = ['triage', 'assist', 'end'];
  const pass = JSON.stringify(result.path) === JSON.stringify(expected);
  console.log(`${pass ? '✅ PASS' : '❌ FAIL'} electrician intake → agent turn: path=${JSON.stringify(result.path)} (expected ${JSON.stringify(expected)})`);
  if (!pass) {
    console.error('\nPack E live-turn E2E FAILED');
    process.exit(1);
  }
  console.log('\nPack E live-turn E2E OK — the electrician vertical (authored as DATA) ran a real agent turn end-to-end on Temporal + the live LLM.');
  process.exit(0);
}

await main();
