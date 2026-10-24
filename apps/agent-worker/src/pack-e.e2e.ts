// Pack E — LIVE electrician turn on real Temporal + a live LLM (MANUAL GATE, not CI: needs
// an OpenAI-compatible endpoint, see README "LLM configuration"). Installs the electrician vertical FROM DATA (verticals/electrician/pack.json)
// for a demo tenant, then drives real inbound turns: the generic workflow interpreter host (runAgentWorkflow)
// interprets the electrician-intake workflow → the electrician-triage rule routes to the dispatcher
// agent node → a REAL bounded agent turn runs against the electrician engine (persona + policy) and the
// live LLM → the workflow completes. Proves the platform runs a real vertical, authored purely as data,
// end-to-end on durable infrastructure.
//
// TWO CASES, because the workflow path alone proves nothing about tools (both intents walk
// triage→assist→end):
//   1. emergency  — a burning smell. The dispatcher answers from SAFETY; the slot tool is offered but
//                   the model correctly has no reason to call it.
//   2. scheduling — a routine booking ask. The model calls appointment.slot.read, which dispatches
//                   through the PROJECTED tool into the REAL provider plane (InternalSchedulerProvider).
// Case 2 is asserted against the DURABLE audit timeline (runtime.tool_executions), not the log: the
// ToolResult's metrics.providerId must be `internal-scheduler` — evidence the turn actually reached a
// provider rather than a fixture.
//
//   docker compose -f infra/docker-compose.yml up -d   (+ an LLM at LLM_BASE_URL)
//   HERMES_CREDENTIALS_MASTER_KEY=<64 hex> pnpm -r build && node apps/agent-worker/dist/pack-e.e2e.js
import {Client, Connection} from '@temporalio/client';
import {loadConfig} from '@hermes-one/config';
import {
  createAuditQueryService,
  createCredentialRowStore,
  createRoleRegistry,
} from '@hermes-one/drizzle';
import {EnvelopeCredentialStore, LocalAesGcmCipher} from '@hermes-one/secrets';
import {
  createWorkflowWorker,
  installElectricianPack,
  WORKFLOW_QUEUE,
} from '@hermes-one/workflow-worker';
import {createActivityWorker} from '@hermes-one/activity-worker';
import type {
  CapabilityName,
  Principal,
  TenantId,
  ToolResult,
} from '@hermes-one/contracts';
import {createAgentWorker} from './worker.js';

const TENANT = 'tnt_elec_demo';
const SLOT_READ = 'appointment.slot.read';

interface Case {
  name: string;
  intent: string;
  /** Whether this intent must drive a real, provider-backed tool call. */
  expectToolCall: boolean;
}

// The TENANT's own slot template — rotated into capability.provider_credentials as an
// envelope-encrypted row before the turn runs. The platform default is 14:00/15:30; seeing THIS
// value in the reply's tool output proves the whole ADR-026 chain live: tenant row → RLS read →
// per-tenant decrypt → ProviderExecutionContext.config → provider behavior. No deploy, one rotate().
const TENANT_SLOT_TEMPLATE = '09:15:00-05:00';

const CASES: Case[] = [
  {
    name: 'emergency → safety reply',
    intent:
      'my breaker keeps tripping and there is a faint burning smell near the panel',
    expectToolCall: false,
  },
  {
    name: 'scheduling → provider-backed slot read (TENANT-OWN credentials)',
    intent:
      'nothing urgent — an outlet in my kitchen stopped working. what appointment slots do you have open on 2026-07-20? please check availability.',
    expectToolCall: true,
  },
];

async function main(): Promise<void> {
  const cfg = loadConfig();

  // 1. Install the electrician vertical from data (author the 5 defs + publish the deployment) —
  //    exactly what the admin API does, headless. Returns the plan refs + the pinned deployment.
  const install = await installElectricianPack(
    cfg.stores.authoritative.url,
    cfg.stores.ephemeral.url,
    TENANT,
  );
  console.log(
    `[pack-e] installed electrician deployment ${install.deployment.deploymentId} (v${install.deployment.version}) for ${TENANT}`,
  );

  // 1b. The tenant brings its own provider configuration (ADR-026): one rotate(), no deploy. The
  //     agent-worker resolves this same row per turn through the envelope store layered over the
  //     platform defaults.
  if (!cfg.credentials)
    throw new Error(
      'pack-e e2e needs HERMES_CREDENTIALS_MASTER_KEY (ADR-026 envelope store)',
    );
  const rows = createCredentialRowStore(cfg.stores.authoritative.url);
  const credStore = new EnvelopeCredentialStore(
    rows.repo,
    new LocalAesGcmCipher(cfg.credentials.masterKey),
  );
  await credStore.rotate(
    TENANT as Parameters<typeof credStore.rotate>[0],
    'internal-scheduler',
    SLOT_READ as CapabilityName,
    {
      slotTemplates: TENANT_SLOT_TEMPLATE,
    },
  );
  await rows.close();
  console.log(
    `[pack-e] rotated tenant-own internal-scheduler credentials (slotTemplates=${TENANT_SLOT_TEMPLATE})`,
  );

  const connection = await Connection.connect({address: cfg.temporal.address});
  const client = new Client({connection, namespace: cfg.temporal.namespace});
  const workflowWorker = await createWorkflowWorker();
  const activityWorker = await createActivityWorker();
  const agentWorker = await createAgentWorker();

  // 2. The acting caller — a customer of the electrician. AUTH-2: scopes are RESOLVED FROM ROLES per
  //    request (no literals). The platform 'customer' role (seed 0029) carries appointment.slot.read,
  //    which is exactly what gates the dispatcher's tool set — the pack's engine allows that capability.
  const {repo: roleRegistry, close: closeRoles} = createRoleRegistry(
    cfg.stores.authoritative.url,
  );
  const principal: Principal = {
    id: 'prn_elec_caller' as Principal['id'],
    tenantId: TENANT as Principal['tenantId'],
    kind: 'user',
    roles: ['customer'],
    scopes: await roleRegistry.resolveScopes(TENANT as Principal['tenantId'], [
      'customer',
    ]),
    attributes: {externalHandle: '+15125550000', channel: 'sms'},
  };
  await closeRoles();
  if (!principal.scopes.includes(SLOT_READ as Principal['scopes'][number])) {
    throw new Error(
      `role resolution did not yield ${SLOT_READ}: ${JSON.stringify(principal.scopes)}`,
    );
  }

  const {repo: audit, close: closeAudit} = createAuditQueryService(
    cfg.stores.authoritative.url,
  );
  const results: {name: string; pass: boolean; detail: string}[] = [];

  const clientWork = (async () => {
    for (const c of CASES) {
      const correlationId = `pack-e-elec-${Date.now()}`;
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
            // Mirrors the ingest edge's minting (`cnv_<short(from)>`) so a handoff turn persists its
            // durable handoff_tasks row exactly as the live path does.
            conversationId: 'cnv_15125550000',
            parameters: install.parameters,
            input: {intent: c.intent},
          },
        ],
      });
      const out = (await handle.result()) as {path: string[]; outcome?: string};

      const pathOk =
        JSON.stringify(out.path) ===
        JSON.stringify(['triage', 'assist', 'end']);

      // The DURABLE proof: the audit timeline joins runtime.tool_executions, so a tool entry here means
      // the call was really dispatched AND committed — and metrics.providerId names the adapter that
      // served it. A fixture could never put 'internal-scheduler' in that field.
      const timeline = await audit.composeTimeline(
        TENANT as TenantId,
        correlationId,
      );
      const toolCalls = timeline
        .filter(e => e.kind === 'tool-execution' && e.detail !== null)
        .map(e => e.detail as ToolResult)
        .filter(r => r.capability === SLOT_READ);
      const viaProvider = toolCalls.filter(
        r => r.metrics?.providerId === 'internal-scheduler',
      );

      // The slots must carry the TENANT's template — platform defaults here mean the envelope
      // chain silently fell through, which is exactly the regression this guards against.
      const tenantSlots = viaProvider.every(r =>
        ((r.output as {slots?: string[]})?.slots ?? []).every(slot =>
          slot.endsWith(`T${TENANT_SLOT_TEMPLATE}`),
        ),
      );
      const toolOk = c.expectToolCall
        ? viaProvider.length > 0 && viaProvider.every(r => r.ok) && tenantSlots
        : true;
      results.push({
        name: c.name,
        pass: pathOk && toolOk,
        detail: `path=${JSON.stringify(out.path)} toolCalls=${toolCalls.length} viaInternalScheduler=${viaProvider.length}${
          viaProvider[0]?.output
            ? ` slots=${JSON.stringify((viaProvider[0].output as {slots?: unknown}).slots)}`
            : ''
        }`,
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

  for (const r of results)
    console.log(`${r.pass ? '✅ PASS' : '❌ FAIL'} ${r.name}: ${r.detail}`);
  if (results.some(r => !r.pass) || results.length !== CASES.length) {
    console.error('\nPack E live-turn E2E FAILED');
    process.exit(1);
  }
  console.log(
    "\nPack E live-turn E2E OK — the electrician vertical (authored as DATA) ran real agent turns end-to-end on Temporal + the live LLM, and the scheduling turn reached the REAL provider plane through the tenant's OWN envelope-encrypted credentials (ADR-026).",
  );
  process.exit(0);
}

await main();
