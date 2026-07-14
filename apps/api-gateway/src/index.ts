// @platform-internal/api-gateway — app (edge plane).
// The inbound channel webhook ingress: verify → normalize → persist → start workflow. Composition root
// wires the SMS transport, the substrate store, the message repository, and the Temporal client.
import {Client, Connection} from '@temporalio/client';
import {EnvSecretProvider, loadConfig} from '@platform-internal/config';
import {assertRlsPostureAtBoot, createCompiledPlanStore, createMessageRepository} from '@platform-internal/drizzle';
import {createRedisClient, RedisNonceStore} from '@platform-internal/redis';
import {SmsChannelTransport, type TenantByNumber} from '@platform-internal/channels';
import {initTracing, tracingConfigFor} from '@platform-internal/telemetry';
import {SecretRef, type TenantId} from '@platform/contracts';
import {createGatewayServer} from './server.js';

export {createGatewayServer, type GatewayDeps} from './server.js';
export {startFromInbound, type IngestDeps, type StartedWorkflow} from './ingestor.js';

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
export async function createInboundGateway(gw: GatewayConfig): Promise<GatewayHandle> {
  const cfg = loadConfig();
  // RLS boot self-check (row-level-security.md): a bypass-capable login fails startup, not silently.
  await assertRlsPostureAtBoot(cfg.stores.authoritative.url);
  const {store, close: closeStore} = createCompiledPlanStore(cfg.stores.authoritative.url, cfg.stores.ephemeral.url);
  const {repo: messages, close: closeMessages} = createMessageRepository(cfg.stores.authoritative.url);
  const connection = await Connection.connect({address: cfg.temporal.address});
  const client = new Client({connection, namespace: cfg.temporal.namespace});

  // AUTH-1 webhook posture (docs/design/001-edge-authn-design.md): timestamp-in-signed-material +
  // skew window (transport defaults) + Redis replay guard; the signing secret arrives inline (dev/e2e)
  // or via the SecretRef seam (prod path — env-backed provider today, cloud secret manager later).
  const nonceRedis = createRedisClient(cfg.stores.ephemeral.url);
  const transport = new SmsChannelTransport({
    ...(gw.signingSecret
      ? {signingSecret: gw.signingSecret}
      : {signingSecretRef: SecretRef.parse('secret://env/sms-webhook-signing'), secrets: new EnvSecretProvider()}),
    signatureHeader: 'x-signature',
    nonces: new RedisNonceStore(nonceRedis),
    tenantByNumber: gw.tenantByNumber,
  });

  // OTel tracing (OB5): the gateway opens the `edge.request` root span for each webhook.
  const tracing = initTracing(tracingConfigFor(cfg.otel, 'hermes-api-gateway'));

  const server = createGatewayServer({
    transport,
    ingest: {store, messages, client, parametersFor: gw.parametersFor},
    tracer: tracing.tracer,
  });

  return {
    server,
    close: async () => {
      await connection.close();
      await closeStore();
      await closeMessages();
      await nonceRedis.close();
      await tracing.shutdown();
    },
  };
}

export const descriptor = {
  name: '@platform-internal/api-gateway',
  role: 'app',
  plane: 'edge',
  published: false,
  sourceDocs: ['api/workflow-and-conversation-api', 'contracts/provider-contracts'],
  governedBy: ['ADR-014'],
} as const;
