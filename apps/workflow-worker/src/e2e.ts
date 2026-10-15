// Self-contained e2e for the split worker topology on REAL local Temporal.
// Runs the workflow-worker (workflow-only) + activity-worker in one process (each
// on its own task queue — real Temporal task-queue routing) and submits the
// missed-call workflow by name via the client. `Worker.runUntil` keeps both
// workers alive only for the client work, then exits.
//
//   docker compose -f infra/docker-compose.yml up -d
//   pnpm -r build && node apps/workflow-worker/dist/e2e.js
import {Client, Connection} from '@temporalio/client';
import {loadConfig} from '@platform-internal/config';
import {createActivityWorker} from '@platform-internal/activity-worker';
import {createWorkflowWorker} from './worker.js';
import {WORKFLOW_QUEUE} from './queues.js';
import {buildBundle, bundleToRef} from './bundle.js';
import {publishBundle, E2E_TENANT} from './publish.js';

const CASES = [
  {
    name: 'eligible',
    input: {channel: 'voice', answered: false, zip: '75001', from: '+15551234'},
    expect: ['eligibility', 'reply', 'end'],
  },
  {
    name: 'out-of-area',
    input: {channel: 'voice', answered: false, zip: '99999', from: '+15559999'},
    expect: ['eligibility', 'end'],
  },
  {
    name: 'answered',
    input: {channel: 'voice', answered: true, zip: '75001', from: '+15550000'},
    expect: ['eligibility', 'end'],
  },
];

async function main() {
  const cfg = loadConfig();

  // Publish the compiled plans to the real Postgres plan store (ADR-014); the
  // workflow is then started with only refs and loads them via an activity.
  const bundle = buildBundle({});
  await publishBundle(
    bundle,
    cfg.stores.authoritative.url,
    cfg.stores.ephemeral.url,
  );

  const connection = await Connection.connect({address: cfg.temporal.address});
  const client = new Client({connection, namespace: cfg.temporal.namespace});
  const workflowWorker = await createWorkflowWorker();
  const activityWorker = await createActivityWorker();

  const clientWork = (async () => {
    const out: {name: string; path: string[]; expect: string[]}[] = [];
    for (const c of CASES) {
      const handle = await client.workflow.start('runMissedCall', {
        taskQueue: WORKFLOW_QUEUE,
        workflowId: `missed-call-${c.name}-${Date.now()}`,
        args: [bundleToRef(bundle, c.input, E2E_TENANT)],
      });
      const r = (await handle.result()) as {path: string[]};
      out.push({name: c.name, path: r.path, expect: c.expect});
    }
    return out;
  })();

  // Run both workers (each polling its own task queue) until the client is done.
  const [results] = await Promise.all([
    clientWork,
    workflowWorker.runUntil(clientWork),
    activityWorker.runUntil(clientWork),
  ]);

  let ok = true;
  for (const r of results) {
    const pass = JSON.stringify(r.path) === JSON.stringify(r.expect);
    console.log(
      `${pass ? '✅ PASS' : '❌ FAIL'} ${r.name}: path=${JSON.stringify(r.path)}`,
    );
    if (!pass) ok = false;
  }
  await connection.close();
  if (!ok) {
    console.error('E2E FAILED');
    process.exit(1);
  }
  console.log(
    '\nE2E OK — split workflow-worker + activity-worker on real Temporal.',
  );
  // The workers hold long-lived pg/Redis handles (CompiledPlanStore); force a clean exit for the demo.
  process.exit(0);
}

await main();
