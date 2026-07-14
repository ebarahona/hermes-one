// @platform-internal/api-gateway — app (edge plane).
// The inbound channel webhook ingress: verify → normalize → persist → start workflow. Composition root
// wires the SMS transport, the substrate store, the message repository, and the Temporal client.
import {Client, Connection} from '@temporalio/client';
import {loadConfig} from '@platform-internal/config';
import {createCompiledPlanStore, createMessageRepository} from '@platform-internal/drizzle';
import {SmsChannelTransport, type TenantByNumber} from '@platform-internal/channels';
import type {TenantId} from '@platform/contracts';
import {createGatewayServer} from './server.js';

export {createGatewayServer, type GatewayDeps} from './server.js';
export {startFromInbound, type IngestDeps, type StartedWorkflow} from './ingestor.js';

export interface GatewayConfig {
  /** HMAC secret the vendor signs webhook bodies with. */
  signingSecret: string;
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
  const {store, close: closeStore} = createCompiledPlanStore(cfg.stores.authoritative.url, cfg.stores.ephemeral.url);
  const {repo: messages, close: closeMessages} = createMessageRepository(cfg.stores.authoritative.url);
  const connection = await Connection.connect({address: cfg.temporal.address});
  const client = new Client({connection, namespace: cfg.temporal.namespace});

  const transport = new SmsChannelTransport({
    signingSecret: gw.signingSecret,
    signatureHeader: 'x-signature',
    tenantByNumber: gw.tenantByNumber,
  });

  const server = createGatewayServer({
    transport,
    ingest: {store, messages, client, parametersFor: gw.parametersFor},
  });

  return {
    server,
    close: async () => {
      await connection.close();
      await closeStore();
      await closeMessages();
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
