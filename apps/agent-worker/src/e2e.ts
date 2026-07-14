// Full three-plane e2e on REAL local Temporal: workflow-worker (edge) +
// activity-worker (edge) + agent-worker (agent) each poll their own task queue.
// The triage workflow's rule routes a `complex` intent into a REAL bounded agent
// turn (single-step loop dispatching a real agentback tool, as a Temporal
// activity on the agent plane) and a `simple` intent into a deterministic
// capability reply. Proves the platform thesis on real durable infrastructure.
//
//   docker compose -f infra/docker-compose.yml up -d
//   pnpm -r build && node apps/agent-worker/dist/e2e.js
import {Client, Connection} from '@temporalio/client';
import {loadConfig} from '@platform-internal/config';
import {
  createWorkflowWorker,
  buildTriageBundle,
  bundleToRef,
  publishBundle,
  publishAgentDeployment,
  E2E_TENANT,
  WORKFLOW_QUEUE,
} from '@platform-internal/workflow-worker';
import {createActivityWorker} from '@platform-internal/activity-worker';
import {createAgentWorker} from './worker.js';

const CASES = [
  {
    name: 'complex→agent',
    input: {intent: 'complex', date: '2026-07-12'},
    expectPath: ['triage', 'assist', 'end'],
  },
  {
    name: 'simple→reply',
    input: {intent: 'simple'},
    expectPath: ['triage', 'reply', 'end'],
  },
  {
    name: 'other→ignore',
    input: {intent: 'spam'},
    expectPath: ['triage', 'end'],
  },
];

async function main() {
  const cfg = loadConfig();

  // Publish the triage plans content-addressed; start by ref (ADR-014). Then publish a real active
  // deployment (engine + capability + policy) so the agent turn is deployment-driven, not hardcoded.
  const bundle = buildTriageBundle({});
  await publishBundle(bundle, cfg.stores.authoritative.url, cfg.stores.ephemeral.url);
  // The publish returns the DeploymentRef the runs are PINNED to (D1) — the agent turn resolves this
  // exact deployment, not whatever is active at turn time.
  const deployed = await publishAgentDeployment(bundle, cfg.stores.authoritative.url, cfg.stores.ephemeral.url);

  const connection = await Connection.connect({address: cfg.temporal.address});
  const client = new Client({connection, namespace: cfg.temporal.namespace});
  const workflowWorker = await createWorkflowWorker();
  const activityWorker = await createActivityWorker();
  const agentWorker = await createAgentWorker();

  const clientWork = (async () => {
    const out: {name: string; path: string[]; expect: string[]}[] = [];
    for (const c of CASES) {
      const handle = await client.workflow.start('runTriage', {
        taskQueue: WORKFLOW_QUEUE,
        workflowId: `triage-${c.name}-${Date.now()}`,
        args: [bundleToRef(bundle, c.input, E2E_TENANT, {deploymentId: deployed.deploymentId, version: deployed.version})],
      });
      const r = (await handle.result()) as {path: string[]};
      out.push({name: c.name, path: r.path, expect: c.expectPath});
    }
    return out;
  })();

  const [results] = await Promise.all([
    clientWork,
    workflowWorker.runUntil(clientWork),
    activityWorker.runUntil(clientWork),
    agentWorker.runUntil(clientWork),
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
    '\nE2E OK — 3-plane topology (workflow + activity + agent) on real Temporal.',
  );
  // The workers hold long-lived pg/Redis + agentback handles; force a clean exit for the demo.
  process.exit(0);
}

await main();
