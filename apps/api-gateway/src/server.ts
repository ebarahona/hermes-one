// api-gateway (edge plane): the HTTP ingress for inbound channel webhooks. A verified webhook is
// normalized to an InboundMessage and handed to the ingestor, which persists it and starts the workflow.
// NOTE (flagged): this is a thin node:http handler for the *channel webhook* ingress (channel ingestion,
// not the admin REST surface). The admin/API surface (workflow/conversation/tenant controllers) is
// LoopBack REST per api/*.md — a separate, later build.
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {SmsChannelTransport} from '@platform-internal/channels';
import {startFromInbound, type IngestDeps} from './ingestor.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const lowerHeaders = (req: IncomingMessage): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');
  return out;
};

export interface GatewayDeps {
  transport: SmsChannelTransport;
  ingest: IngestDeps;
}

/** Build the inbound webhook HTTP server. POST /webhooks/sms → verify → ingest → start workflow. */
export function createGatewayServer(deps: GatewayDeps): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/webhooks/sms') {
      res.writeHead(404).end();
      return;
    }
    try {
      const rawBody = await readBody(req);
      const parsed = JSON.parse(rawBody || '{}');
      const msg = await deps.transport.ingest({rawBody, parsed}, lowerHeaders(req));
      if (!msg) {
        res.writeHead(204).end(); // verified but dropped (not our tenant / malformed)
        return;
      }
      const started = await startFromInbound(msg, deps.ingest);
      res.writeHead(202, {'content-type': 'application/json'}).end(JSON.stringify(started));
    } catch (err) {
      // Signature failure or malformed request — reject without starting anything.
      res.writeHead(401, {'content-type': 'application/json'}).end(
        JSON.stringify({error: (err as Error).message}),
      );
    }
  });
}
