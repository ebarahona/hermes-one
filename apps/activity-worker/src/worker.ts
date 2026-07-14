// activity-worker (edge plane): hosts the non-agent Temporal activities on the
// `hermes-activity` task queue. Runs no workflows. Connects to local Temporal
// (127.0.0.1:7233, default namespace).
//
// MIGRATED onto the LB4 composition layer (F6/T1, loopback/application-bootstrap.md): the
// composition root builds a PlatformApplication, registers the component subset from the per-app
// bootstrap matrix (Observability, Persistence, CapabilityRegistry, RuleRuntime — TenantCore /
// Memory / Channel components are Phase 2), contributes the provider adapters to the
// `providerAdapters` extension point as TAGGED bindings, and resolves every activity dependency
// from the container. `app.start()` runs the lifecycle observers — including the fail-closed RLS
// boot gate (role posture + tenant-GUC preflight) that used to be a manual call here.
import 'reflect-metadata';
import {fileURLToPath} from 'node:url';
import {NativeConnection, Worker} from '@temporalio/worker';
import {loadConfig, type HermesConfig} from '@platform-internal/config';
import {
  CapabilityRegistryComponent,
  ObservabilityComponent,
  PersistenceComponent,
  PlatformApplication,
  PlatformBindings,
  RuleRuntimeComponent,
  type IndexedCapabilityRegistry,
} from '@platform-internal/loopback-core';
import {
  EventOutboxPublisherLoop,
  type DrizzleAuditSink,
  type DrizzleEventOutboxRepository,
} from '@platform-internal/drizzle';
import {RedisPubSubEventPublisher} from '@platform-internal/redis';
import type {TenantId} from '@platform/contracts';
import {ChannelComponent, messagingReplySendContract} from '@platform-internal/channels';
import {withPlatformFailures} from '@platform-internal/temporal-client';
import {createRuleActivities} from './activities.js';
import {createPlanActivities} from './plan-activities.js';
import {createCapabilityActivities} from './capability-activities.js';
import {createDecisionActivities} from './decision-activities.js';

export const ACTIVITY_QUEUE = 'hermes-activity';

/**
 * Build the activity-worker's PlatformApplication: bind config, register the component subset,
 * and contribute the channel providers to the capability plane's extension point.
 */
export function createActivityWorkerApp(cfg: HermesConfig): PlatformApplication {
  const app = new PlatformApplication();
  app.bind(PlatformBindings.CONFIG.key).to(cfg); // constant value — scope-independent

  // Per the bootstrap matrix (application-bootstrap.md): Observability, Persistence,
  // CapabilityRegistry, RuleRuntime, Channel. The ChannelComponent contributes the provider adapters
  // to the capability extension point (internal message-log always; the SMS vendor when configured).
  app.component(ObservabilityComponent);
  app.component(PersistenceComponent);
  app.component(CapabilityRegistryComponent);
  app.component(RuleRuntimeComponent);
  app.component(ChannelComponent);
  return app;
}

export async function createActivityWorker(): Promise<Worker> {
  const cfg = loadConfig();
  const app = createActivityWorkerApp(cfg);

  // Lifecycle observers: pool wiring + the fail-closed RLS boot gate (ADR-022) — a bypass-capable
  // login or a broken tenant GUC fails startup here, before any activity polls.
  await app.start();

  // Seed the capability plane from the pinned contract (in production the active deployment's
  // CapabilityManifest seeds this — unchanged from the pre-migration wiring, flagged).
  const registry = (await app.get(PlatformBindings.CAPABILITY_REGISTRY)) as IndexedCapabilityRegistry;
  await registry.register(messagingReplySendContract());

  const plans = await app.get(PlatformBindings.COMPILED_PLAN_STORE);
  const invoker = await app.get(PlatformBindings.CAPABILITY_INVOKER);
  const audit = (await app.get(PlatformBindings.AUDIT_SINK)) as DrizzleAuditSink;
  const ruleRuntime = await app.get(PlatformBindings.RULE_RUNTIME);

  // Transactional-outbox publisher (events/event-envelope.md): opt-in via HERMES_OUTBOX_TENANTS
  // (per-tenant RLS drain; the cross-tenant relay role is an unresolved spec question — flagged).
  if (cfg.outbox.tenants.length > 0) {
    const outbox = (await app.get(PlatformBindings.EVENT_OUTBOX_REPOSITORY)) as DrizzleEventOutboxRepository;
    const redis = await app.get(PlatformBindings.REDIS);
    const loop = new EventOutboxPublisherLoop(
      outbox,
      new RedisPubSubEventPublisher(redis, cfg.outbox.channelPattern),
      cfg.outbox.tenants as TenantId[],
      {pollIntervalMs: cfg.outbox.pollIntervalMs, batchSize: 50, schemaVersionByType: {}},
    );
    loop.start();
    console.log(`outbox publisher: draining ${cfg.outbox.tenants.join(', ')} every ${cfg.outbox.pollIntervalMs}ms`);
  }

  const connection = await NativeConnection.connect({address: cfg.temporal.address});
  return Worker.create({
    connection,
    namespace: cfg.temporal.namespace,
    // withPlatformFailures: a thrown PlatformErrorException reaches Temporal as the stable typed
    // ApplicationFailure so the retry-policy registry's nonRetryableErrorTypes can match it
    // (retry-policy-registry.md acceptance criterion 8).
    activities: withPlatformFailures({
      ...createRuleActivities(ruleRuntime),
      ...createPlanActivities(plans),
      ...createCapabilityActivities(invoker, registry.lookup),
      ...createDecisionActivities(audit),
    }),
    taskQueue: ACTIVITY_QUEUE,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const worker = await createActivityWorker();
  console.log(
    `activity-worker: polling '${ACTIVITY_QUEUE}' on ${loadConfig().temporal.address}`,
  );
  await worker.run();
}
