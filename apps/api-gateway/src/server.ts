// api-gateway (edge plane): the HTTP ingress for inbound channel webhooks. A verified webhook is
// normalized to an InboundMessage and handed to the ingestor, which persists it and starts the workflow.
// NOTE (flagged): this is a thin node:http handler for the *channel webhook* ingress (channel ingestion,
// not the admin REST surface). The admin/API surface (workflow/conversation/tenant controllers) is
// LoopBack REST per api/*.md — a separate, later build.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type {SmsChannelTransport} from '@hermes-one/channels';
import type {Tracer} from '@hermes-one/telemetry';
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
  for (const [k, v] of Object.entries(req.headers))
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');
  return out;
};

export interface GatewayDeps {
  transport: SmsChannelTransport;
  ingest: IngestDeps;
  /** Opens the `edge.request` root span (OB5) — the top of the span tree edge→workflow→activity→turn→tool. */
  tracer: Tracer;
}

/** Build the inbound webhook HTTP server. POST /webhooks/sms → verify → ingest → start workflow. */
export function createGatewayServer(deps: GatewayDeps): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/webhooks/sms') {
      res.writeHead(404).end();
      return;
    }
    // edge.request: the trace root. Its traceparent is threaded onto the workflow start ref so the whole
    // downstream (workflow → activity → turn → tool) joins one trace.
    const span = deps.tracer.startSpan('edge.request', {
      attributes: {'http.route': '/webhooks/sms'},
    });
    try {
      const rawBody = await readBody(req);
      const parsed = JSON.parse(rawBody || '{}');
      const msg = await deps.transport.ingest(
        {rawBody, parsed},
        lowerHeaders(req),
      );
      if (!msg) {
        span.end(); // verified but dropped (not our tenant / malformed)
        res.writeHead(204).end();
        return;
      }
      const started = await startFromInbound(
        msg,
        deps.ingest,
        span.traceparent,
      );
      span.setAttributes({
        'tenant.id': msg.tenantId,
        'workflow.id': started.workflowId,
      });
      span.end();
      res
        .writeHead(202, {'content-type': 'application/json'})
        .end(JSON.stringify(started));
    } catch (err) {
      // Verification failure or malformed request — reject without starting anything. The body is
      // GENERIC (no claim/schema/reason leakage on 401); the real
      // reason goes to the span/log only.
      span.end({ok: false, error: err as Error});
      res
        .writeHead(401, {'content-type': 'application/json'})
        .end(JSON.stringify({error: 'Authentication failed.'}));
    }
  });
}
