// @hermes-one/api-gateway — app (edge plane).
// The inbound channel webhook ingress: verify → normalize → persist → start workflow.
//
// MIGRATED onto the LB4 composition layer (Phase 2a): the
// composition root builds a PlatformApplication (Observability + Persistence over ONE shared pool),
// resolves the store/messages/roles/redis from the container, and `app.start()` runs the lifecycle
// observers — including the fail-closed RLS boot gate. The HTTP ingress itself stays a thin
// `node:http` handler (flagged L3/E1): the LB4 REST surface (RestApplication + sequence, api/*.md)
// is the admin-api build.
import 'reflect-metadata';
import {Client, Connection} from '@temporalio/client';
import {EnvSecretProvider, loadConfig} from '@hermes-one/config';
import {
  ObservabilityComponent,
  PersistenceComponent,
  PlatformApplication,
  PlatformBindings,
} from '@hermes-one/loopback-core';
import {RedisNonceStore} from '@hermes-one/redis';
import {SmsChannelTransport, type TenantByNumber} from '@hermes-one/channels';
import {initTracing, tracingConfigFor} from '@hermes-one/telemetry';
import {SecretRef, type TenantId} from '@hermes-one/contracts';
import {createGatewayServer} from './server.js';

export {createGatewayServer, type GatewayDeps} from './server.js';
export {
  startFromInbound,
  type IngestDeps,
  type StartedWorkflow,
} from './ingestor.js';

export interface GatewayConfig {
  /** Inline HMAC secret (dev/e2e). When absent, the signing secret resolves via SecretRef —
   *  `secret://env/sms-webhook-signing` through EnvSecretProvider (AUTH-1; cloud provider in prod). */
  signingSecret?: string;
  /** Destination-number → tenant map (a signed webhook only reaches the tenant that owns the number). */
  tenantByNumber: TenantByNumber;
  /** Rule parameters per tenant (demo stand-in for tenant configuration). */
  parametersFor: (tenantId: TenantId) => Record<string, unknown>;
}

export interface GatewayHandle {
  server: ReturnType<typeof createGatewayServer>;
  close(): Promise<void>;
}

/** Wire the inbound gateway from config. Callers `listen()` on the returned server. */
export async function createInboundGateway(
  gw: GatewayConfig,
): Promise<GatewayHandle> {
  const cfg = loadConfig();
  const app = new PlatformApplication();
  app.bind(PlatformBindings.CONFIG.key).to(cfg);
  app.component(ObservabilityComponent);
  app.component(PersistenceComponent);

  // Lifecycle observers: the fail-closed RLS boot gate (role posture + tenant-GUC preflight) runs
  // here — a bypass-capable login fails startup before the server ever listens.
  await app.start();

  const store = await app.get(PlatformBindings.COMPILED_PLAN_STORE);
  const messages = await app.get(PlatformBindings.MESSAGE_REPOSITORY);
  const roles = await app.get(PlatformBindings.ROLE_REGISTRY);
  const redis = await app.get(PlatformBindings.REDIS);

  const connection = await Connection.connect({address: cfg.temporal.address});
  const client = new Client({connection, namespace: cfg.temporal.namespace});

  // AUTH-1 webhook posture (docs/design/001-edge-authn-design.md): timestamp-in-signed-material +
  // skew window (transport defaults) + Redis replay guard; the signing secret arrives inline (dev/e2e)
  // or via the SecretRef seam (prod path — env-backed provider today, cloud secret manager later).
  const transport = new SmsChannelTransport({
    ...(gw.signingSecret
      ? {signingSecret: gw.signingSecret}
      : {
          signingSecretRef: SecretRef.parse('secret://env/sms-webhook-signing'),
          secrets: new EnvSecretProvider(),
        }),
    signatureHeader: 'x-signature',
    nonces: new RedisNonceStore(redis),
    tenantByNumber: gw.tenantByNumber,
  });

  // OTel tracing (OB5): the gateway opens the `edge.request` root span for each webhook.
  const tracing = initTracing(tracingConfigFor(cfg.otel, 'hermes-api-gateway'));

  const server = createGatewayServer({
    transport,
    ingest: {store, messages, roles, client, parametersFor: gw.parametersFor},
    tracer: tracing.tracer,
  });

  return {
    server,
    close: async () => {
      await connection.close();
      await app.stop(); // observers close the shared pool + redis in reverse order
      await tracing.shutdown();
    },
  };
}

export const descriptor = {
  name: '@hermes-one/api-gateway',
  role: 'app',
  plane: 'edge',
  published: false,
  governedBy: ['ADR-014', 'ADR-017', 'ADR-022'],
} as const;
