// activity-worker (edge plane): hosts the non-agent Temporal activities on the
// `hermes-activity` task queue. Runs no workflows. Connects to local Temporal
// (127.0.0.1:7233, default namespace).
import {fileURLToPath} from 'node:url';
import {NativeConnection, Worker} from '@temporalio/worker';
import {loadConfig} from '@platform-internal/config';
import {
  assertRlsPostureAtBoot,
  createCompiledPlanStore,
  createEventOutboxRepository,
  createMessageRepository,
  createAuditSink,
  EventOutboxPublisherLoop,
} from '@platform-internal/drizzle';
import {createRedisClient, RedisPubSubEventPublisher} from '@platform-internal/redis';
import type {TenantId} from '@platform/contracts';
import {
  CapabilityInvoker,
  ProviderRegistry,
  ProviderResolver,
  type CapabilityLookup,
} from '@platform/capability-contract';
import type {CapabilityContract, CapabilityName} from '@platform/contracts';
import type {ProviderAdapter} from '@platform/contracts';
import {
  PersistingMessageProvider,
  SmsChannelTransport,
  StaticProviderCredentialStore,
  VendorSmsProvider,
  TWILIO_SMS_PROVIDER_ID,
  messagingReplySendContract,
  MESSAGING_REPLY_SEND,
} from '@platform-internal/channels';
import {withPlatformFailures} from '@platform-internal/temporal-client';
import * as effectActivities from './activities.js';
import {createPlanActivities} from './plan-activities.js';
import {createCapabilityActivities} from './capability-activities.js';
import {createDecisionActivities} from './decision-activities.js';

export const ACTIVITY_QUEUE = 'hermes-activity';

export async function createActivityWorker(): Promise<Worker> {
  const cfg = loadConfig();
  // RLS boot self-check (row-level-security.md): a bypass-capable login fails startup, not silently.
  await assertRlsPostureAtBoot(cfg.stores.authoritative.url);
  const connection = await NativeConnection.connect({
    address: cfg.temporal.address,
  });
  // Composition root: the ONE place that maps store role URLs to a concrete adapter (Drizzle +
  // Redis) behind the CompiledPlanStore port. Migrations run out-of-band (platform_migrator), not
  // here. The activities depend on the port, not the adapter.
  const plans = createCompiledPlanStore(
    cfg.stores.authoritative.url,
    cfg.stores.ephemeral.url,
  );

  // Capability plane: the messaging provider persists outbound messages to runtime.messages; the
  // resolver/invoker route the capability node's send through it. A single pinned contract for now —
  // in production the active deployment's CapabilityManifest seeds the lookup.
  const messages = createMessageRepository(cfg.stores.authoritative.url);
  // Always register the internal message-log provider (persist-only fallback). When an SMS vendor is
  // configured, register the real VendorSmsProvider ahead of it — the contract's provider mapping ranks
  // twilio-sms > internal-message-log, and the resolver fails over to the log provider whenever the
  // vendor's circuit breaker is open. The vendor delivers via SmsChannelTransport (real Twilio HTTP)
  // and resolves creds from the credential-store seam (env-backed here; KMS in prod — flagged).
  const providerList: ProviderAdapter[] = [new PersistingMessageProvider(messages.repo)];
  if (cfg.sms) {
    const transport = new SmsChannelTransport({
      // Inbound fields are unused on this outbound-only instance; deliver() reads creds from ctx.config.
      signingSecret: 'unused-outbound', signatureHeader: 'x-signature', tenantByNumber: () => null,
      vendorBaseUrl: cfg.sms.baseUrl, timeoutMs: cfg.sms.timeoutMs,
    });
    const creds = new StaticProviderCredentialStore({
      [TWILIO_SMS_PROVIDER_ID]: {
        accountSid: cfg.sms.accountSid,
        authToken: cfg.sms.authToken,
        from: cfg.sms.from,
      },
    });
    providerList.unshift(new VendorSmsProvider(transport, messages.repo, creds));
  }
  const providers = new ProviderRegistry(providerList);
  const contracts = new Map<string, CapabilityContract>([
    [MESSAGING_REPLY_SEND, messagingReplySendContract()],
  ]);
  const lookup: CapabilityLookup = name => contracts.get(name as CapabilityName);
  const invoker = new CapabilityInvoker(lookup, new ProviderResolver(providers));

  // Observability: the deterministic rail emits a `decision.rule` audit event per rule decision — the
  // numerator of the deterministic-hit-rate scalability KPI (tenant-scoped, RLS, idempotent on replay).
  const audit = createAuditSink(cfg.stores.authoritative.url);

  // Transactional-outbox publisher (events/event-envelope.md): drain pending outbox rows to tenant-scoped
  // Redis pub/sub channels on a cadence. Opt-in — enabled only when HERMES_OUTBOX_TENANTS names tenants
  // (per-tenant RLS drain; the cross-tenant relay role is an unresolved spec question — flagged).
  if (cfg.outbox.tenants.length > 0) {
    const outbox = createEventOutboxRepository(cfg.stores.authoritative.url, {maxAttempts: cfg.outbox.maxAttempts});
    const pubsub = createRedisClient(cfg.stores.ephemeral.url);
    const loop = new EventOutboxPublisherLoop(
      outbox.repo,
      new RedisPubSubEventPublisher(pubsub, cfg.outbox.channelPattern),
      cfg.outbox.tenants as TenantId[],
      {pollIntervalMs: cfg.outbox.pollIntervalMs, batchSize: 50, schemaVersionByType: {}},
    );
    loop.start();
    console.log(`outbox publisher: draining ${cfg.outbox.tenants.join(', ')} every ${cfg.outbox.pollIntervalMs}ms`);
  }

  return Worker.create({
    connection,
    namespace: cfg.temporal.namespace,
    // withPlatformFailures: a thrown PlatformErrorException reaches Temporal as the stable typed
    // ApplicationFailure so the retry-policy registry's nonRetryableErrorTypes can match it
    // (retry-policy-registry.md acceptance criterion 8).
    activities: withPlatformFailures({
      ...effectActivities,
      ...createPlanActivities(plans.store),
      ...createCapabilityActivities(invoker, lookup),
      ...createDecisionActivities(audit.repo),
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
