// Inbound-channel e2e on REAL Temporal + PG + Redis: a signed SMS webhook POSTed over HTTP to the
// gateway drives the whole loop — verify → normalize → persist inbound → resolve the active deployment →
// start the missed-call workflow → rule decides → capability sends a reply. No e2e client starts the
// workflow; a real inbound event does.
//
//   docker compose -f infra/docker-compose.yml up -d
//   pnpm -r build && node apps/api-gateway/dist/e2e.js
import {createHmac} from 'node:crypto';
import {Client, Connection} from '@temporalio/client';
import {loadConfig} from '@platform-internal/config';
import {
  buildBundle,
  publishBundle,
  publishAgentDeployment,
  createWorkflowWorker,
  E2E_TENANT,
} from '@platform-internal/workflow-worker';
import {createActivityWorker} from '@platform-internal/activity-worker';
import {createInboundGateway} from './index.js';
import type {TenantId} from '@platform/contracts';

const PORT = 8790;
const SECRET = 'dev-webhook-secret';
const TO = '+15125550100'; // the tenant's inbound number

async function main() {
  const cfg = loadConfig();

  // Publish a real active deployment for the tenant (missed-call workflow + rule + policy/engine/capability).
  const bundle = buildBundle({});
  await publishBundle(bundle, cfg.stores.authoritative.url, cfg.stores.ephemeral.url);
  await publishAgentDeployment(bundle, cfg.stores.authoritative.url, cfg.stores.ephemeral.url);

  const workflowWorker = await createWorkflowWorker();
  const activityWorker = await createActivityWorker();
  const gateway = await createInboundGateway({
    signingSecret: SECRET,
    tenantByNumber: to => (to === TO ? (E2E_TENANT as TenantId) : null),
    parametersFor: () => ({serviceZips: ['75001', '75002']}),
  });
  await new Promise<void>(r => gateway.server.listen(PORT, r));

  const connection = await Connection.connect({address: cfg.temporal.address});
  const client = new Client({connection, namespace: cfg.temporal.namespace});

  const clientWork = (async () => {
    // A real inbound missed call from a customer in-area (eligible → the platform texts them back).
    const payload = {From: '+15125559999', To: TO, Body: 'missed you', MessageSid: `SM_${Date.now()}`, Zip: '75001', Answered: false};
    const rawBody = JSON.stringify(payload);
    const signature = createHmac('sha256', SECRET).update(rawBody).digest('hex');

    const res = await fetch(`http://127.0.0.1:${PORT}/webhooks/sms`, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-signature': signature},
      body: rawBody,
    });
    if (res.status !== 202) throw new Error(`gateway returned ${res.status}: ${await res.text()}`);
    const {workflowId} = (await res.json()) as {workflowId: string};

    const result = (await client.workflow.getHandle(workflowId).result()) as {path: string[]};
    return {workflowId, path: result.path};
  })();

  const [out] = await Promise.all([
    clientWork,
    workflowWorker.runUntil(clientWork),
    activityWorker.runUntil(clientWork),
  ]);

  const expected = ['eligibility', 'reply', 'end'];
  const pass = JSON.stringify(out.path) === JSON.stringify(expected);
  console.log(`${pass ? '✅ PASS' : '❌ FAIL'} inbound webhook → workflow: path=${JSON.stringify(out.path)} (id=${out.workflowId})`);

  await connection.close();
  await gateway.close();
  if (!pass) {
    console.error('E2E FAILED');
    process.exit(1);
  }
  console.log('\nE2E OK — a signed inbound webhook drove the missed-call workflow on real Temporal.');
  process.exit(0);
}

await main();
