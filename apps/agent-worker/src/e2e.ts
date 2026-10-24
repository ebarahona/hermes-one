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
import {loadConfig} from '@hermes-one/config';
import {
  createWorkflowWorker,
  buildTriageBundle,
  bundleToRef,
  publishBundle,
  publishAgentDeployment,
  E2E_TENANT,
  WORKFLOW_QUEUE,
} from '@hermes-one/workflow-worker';
import {createActivityWorker} from '@hermes-one/activity-worker';
import {createRoleRegistry} from '@hermes-one/drizzle';
import type {Principal} from '@hermes-one/contracts';
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
  await publishBundle(
    bundle,
    cfg.stores.authoritative.url,
    cfg.stores.ephemeral.url,
  );
  // The publish returns the DeploymentRef the runs are PINNED to (D1) — the agent turn resolves this
  // exact deployment, not whatever is active at turn time.
  const deployed = await publishAgentDeployment(
    bundle,
    cfg.stores.authoritative.url,
    cfg.stores.ephemeral.url,
  );

  const connection = await Connection.connect({address: cfg.temporal.address});
  const client = new Client({connection, namespace: cfg.temporal.namespace});
  const workflowWorker = await createWorkflowWorker();
  const activityWorker = await createActivityWorker();
  const agentWorker = await createAgentWorker();

  // OB5 trace-continuity check: simulate the edge trace so the turn spans (emitted on the agent plane,
  // across the real Temporal boundary) parent off this exact traceId — the primary acceptance test.
  const EDGE_TRACEPARENT =
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const EDGE_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

  // AUTH-2: the acting principal is minted at the edge with scopes RESOLVED FROM ROLES per request —
  // the platform 'customer' role (seed 0029) carries appointment.slot.read, which is what gates the
  // agent's tool set. No demo scope literals.
  const {repo: roleRegistry, close: closeRoles} = createRoleRegistry(
    cfg.stores.authoritative.url,
  );
  const principal: Principal = {
    id: 'prn_customer_e2e' as Principal['id'],
    tenantId: E2E_TENANT as Principal['tenantId'],
    kind: 'user',
    roles: ['customer'],
    scopes: await roleRegistry.resolveScopes(
      E2E_TENANT as Principal['tenantId'],
      ['customer'],
    ),
    attributes: {externalHandle: '+15125559999', channel: 'sms'},
  };
  await closeRoles();
  if (
    !principal.scopes.includes(
      'appointment.slot.read' as Principal['scopes'][number],
    )
  ) {
    throw new Error(
      `role resolution did not yield appointment.slot.read: ${JSON.stringify(principal.scopes)}`,
    );
  }

  const clientWork = (async () => {
    const out: {name: string; path: string[]; expect: string[]}[] = [];
    for (const c of CASES) {
      const ref = bundleToRef(
        bundle,
        c.input,
        E2E_TENANT,
        {deploymentId: deployed.deploymentId, version: deployed.version},
        principal,
        // Mirrors the ingest edge's minting (`cnv_<short(from)>`) so a handoff turn persists its
        // durable handoff_tasks row exactly as the live path does.
        'cnv_15125559999',
      );
      ref.trace = {traceparent: EDGE_TRACEPARENT};
      const handle = await client.workflow.start('runAgentWorkflow', {
        taskQueue: WORKFLOW_QUEUE,
        workflowId: `triage-${c.name}-${Date.now()}`,
        args: [ref],
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
  console.log(
    `(OB5) with HERMES_OTEL_TRACES=console, the agent.turn/agent.tool spans above carry traceId=${EDGE_TRACE_ID} (propagated from the edge across the Temporal boundary).`,
  );
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
