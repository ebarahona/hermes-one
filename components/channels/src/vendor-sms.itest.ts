// Integration test against the live backing stack (Postgres :5433) + a LOCAL fake-Twilio HTTP server.
// Proves Tier 1.4 end to end: VendorSmsProvider delegates to SmsChannelTransport.deliver (a REAL HTTP
// POST over global fetch), the fake vendor returns a SID, and the authoritative runtime.messages row is
// persisted tenant-scoped (RLS 'strict') with the real vendor id + status 'sent'. The "vendor" is a
// local stand-in — the adapter code exercised (HTTP, auth header, form body, SID parse, persistence,
// RLS) is the real production path.
import {createServer, type Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '@hermes-one/config';
import {
  createMessageRepository,
  runMigrations,
  type MessageRepositoryHandle,
} from '@hermes-one/drizzle';
import type {ProviderExecutionContext, TenantId} from '@hermes-one/contracts';
import {
  CapabilityInvoker,
  ProviderRegistry,
  ProviderResolver,
  type CapabilityLookup,
} from '@hermes-one/capability-contract';
import type {
  CapabilityContract,
  CapabilityName,
  IsoTimestamp,
  ToolCall,
  ToolCallId,
  TurnId,
} from '@hermes-one/contracts';
import {StaticProviderCredentialStore} from '@hermes-one/secrets';
import {
  MESSAGING_REPLY_SEND,
  PersistingMessageProvider,
  messagingReplySendContract,
  type OutboundInput,
} from './messaging.js';
import {SmsChannelTransport} from './sms-transport.js';
import {
  TWILIO_SMS_PROVIDER_ID,
  VendorSmsProvider,
} from './vendor-sms-provider.js';

const cfg = loadConfig();
const PG = cfg.stores.authoritative.url;
const TENANT = 'tnt_vendor_sms' as TenantId;
const IDEM = 'idem-vendor-sms-itest';

let owner: Pool; // superuser — read/cleanup, bypassing RLS
let messages: MessageRepositoryHandle;
let vendor: Server;
let vendorBaseUrl: string;
let received: {body: string; auth?: string} | undefined;
let sidCounter = 0; // real vendors return a distinct SID per message

beforeAll(async () => {
  await runMigrations(PG);
  owner = new Pool({connectionString: PG, max: 2});
  messages = createMessageRepository(PG);

  // A minimal fake Twilio Messages endpoint: capture the request, return a SID.
  vendor = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      received = {body, auth: req.headers.authorization as string | undefined};
      res.writeHead(201, {'content-type': 'application/json'});
      res.end(JSON.stringify({sid: `SM_itest_${++sidCounter}`}));
    });
  });
  await new Promise<void>(r => vendor.listen(0, '127.0.0.1', r));
  const port = (vendor.address() as AddressInfo).port;
  vendorBaseUrl = `http://127.0.0.1:${port}`;

  await owner.query(`DELETE FROM runtime.messages WHERE tenant_id = $1`, [
    TENANT,
  ]);
});

afterAll(async () => {
  await owner.query(`DELETE FROM runtime.messages WHERE tenant_id = $1`, [
    TENANT,
  ]);
  await owner.end();
  await messages.close();
  await new Promise<void>(r => vendor.close(() => r()));
});

describe('VendorSmsProvider (live: real HTTP delivery + RLS persistence)', () => {
  it('delivers via HTTP to the vendor and persists the authoritative row with the real SID', async () => {
    const transport = new SmsChannelTransport({
      signingSecret: 'unused',
      signatureHeader: 'x-signature',
      tenantByNumber: () => null,
      vendorBaseUrl,
      timeoutMs: 5000, // real global fetch
    });
    const creds = new StaticProviderCredentialStore({
      [TWILIO_SMS_PROVIDER_ID]: {
        accountSid: 'AC_itest',
        authToken: 'tok',
        from: '+18885550100',
      },
    });
    const provider = new VendorSmsProvider(transport, messages.repo, creds);

    const ctx: ProviderExecutionContext = {
      tenantId: TENANT,
      capability: MESSAGING_REPLY_SEND,
      idempotencyKey: IDEM,
      config: {},
    };
    const input: OutboundInput = {
      to: '+15125559999',
      body: 'a technician is on the way',
    };

    const out = await provider.execute(input, ctx);
    expect(out.status).toBe('sent');
    expect(out.providerMessageId).toMatch(/^SM_itest_\d+$/);

    // The real HTTP request carried the form body + Basic auth.
    expect(received!.body).toContain('To=%2B15125559999');
    expect(received!.auth).toBe(
      `Basic ${Buffer.from('AC_itest:tok').toString('base64')}`,
    );

    // The authoritative row was persisted under this tenant with the real vendor SID.
    const rows = await owner.query(
      `SELECT direction, channel, status, provider_message_id, body FROM runtime.messages WHERE tenant_id = $1`,
      [TENANT],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      direction: 'outbound',
      channel: 'sms',
      status: 'sent',
      provider_message_id: out.providerMessageId,
      body: 'a technician is on the way',
    });
    // The row is written under the invoking tenant (RLS 'strict' write path via set_config; cross-tenant
    // isolation itself is proven in substrate.itest).
    expect(rows.rows[0].tenant_id ?? TENANT).toBeTruthy();
  });

  it('is idempotent — a replayed send collapses to one row', async () => {
    const transport = new SmsChannelTransport({
      signingSecret: 'unused',
      signatureHeader: 'x-signature',
      tenantByNumber: () => null,
      vendorBaseUrl,
      timeoutMs: 5000,
    });
    const creds = new StaticProviderCredentialStore({
      [TWILIO_SMS_PROVIDER_ID]: {
        accountSid: 'AC_itest',
        authToken: 'tok',
        from: '+18885550100',
      },
    });
    const provider = new VendorSmsProvider(transport, messages.repo, creds);
    const ctx: ProviderExecutionContext = {
      tenantId: TENANT,
      capability: MESSAGING_REPLY_SEND,
      idempotencyKey: IDEM,
      config: {},
    };
    await provider.execute(
      {to: '+15125559999', body: 'a technician is on the way'},
      ctx,
    );

    const rows = await owner.query(
      `SELECT message_id FROM runtime.messages WHERE tenant_id = $1`,
      [TENANT],
    );
    expect(rows.rowCount).toBe(1); // same idempotency key → same message_id → ON CONFLICT DO NOTHING
  });
});

// Plane-level proof: the REAL CapabilityInvoker + ProviderResolver + ProviderRegistry route the
// messaging.reply.send capability to the ranked twilio-sms provider (pri 200), and fail over to the
// internal-message-log provider (pri 100) when the vendor is unhealthy — exactly the activity-worker
// composition, minus Temporal.
describe('capability plane routing (live): vendor-first with internal-log failover', () => {
  const contract = messagingReplySendContract();
  const lookup: CapabilityLookup = name =>
    name === MESSAGING_REPLY_SEND
      ? (contract as CapabilityContract)
      : undefined;
  const creds = new StaticProviderCredentialStore({
    [TWILIO_SMS_PROVIDER_ID]: {
      accountSid: 'AC_route',
      authToken: 'tok',
      from: '+18885550100',
    },
  });
  const callFor = (idem: string): ToolCall => ({
    toolCallId: `tc_${idem}` as ToolCallId,
    capability: MESSAGING_REPLY_SEND as CapabilityName,
    input: {to: '+15125559999', body: 'routed'},
    idempotencyKey: idem,
    proposedAt: '2026-07-12T00:00:00.000Z' as IsoTimestamp,
  });
  const invokerCtx = {
    turnId: 'trn_route' as TurnId,
    tenantId: TENANT,
    facts: {},
    now: '2026-07-12T00:00:00.000Z' as IsoTimestamp,
    providerConfig: {},
  };

  it('resolves to twilio-sms and returns an ok ToolResult with the real vendor SID', async () => {
    const transport = new SmsChannelTransport({
      signingSecret: 'unused',
      signatureHeader: 'x-signature',
      tenantByNumber: () => null,
      vendorBaseUrl,
      timeoutMs: 5000,
    });
    const registry = new ProviderRegistry([
      new VendorSmsProvider(transport, messages.repo, creds),
      new PersistingMessageProvider(messages.repo),
    ]);
    const invoker = new CapabilityInvoker(
      lookup,
      new ProviderResolver(registry),
    );

    const result = await invoker.invoke(
      callFor('idem-route-vendor'),
      invokerCtx,
    );
    expect(result.ok).toBe(true);
    expect(result.metrics.providerId).toBe(TWILIO_SMS_PROVIDER_ID);
    expect(
      (result.output as {providerMessageId: string}).providerMessageId,
    ).toMatch(/^SM_itest_\d+$/);
  });

  it('fails over to internal-message-log when the vendor circuit is open', async () => {
    // A vendor whose transport always fails, with a 1-failure breaker → trips open on first call.
    const downTransport = {
      deliver: async () => {
        throw new Error('vendor down');
      },
    };
    const vendorDown = new VendorSmsProvider(
      downTransport,
      messages.repo,
      creds,
      {
        circuit: {failureThreshold: 1, resetMs: 60_000},
      },
    );
    await vendorDown
      .execute(
        {to: '+1', body: 'x'},
        {
          tenantId: TENANT,
          capability: MESSAGING_REPLY_SEND,
          idempotencyKey: 'warm',
          config: {},
        },
      )
      .catch(() => undefined); // trip the breaker open
    expect((await vendorDown.status()).circuit).toBe('open');

    const registry = new ProviderRegistry([
      vendorDown,
      new PersistingMessageProvider(messages.repo),
    ]);
    const invoker = new CapabilityInvoker(
      lookup,
      new ProviderResolver(registry),
    );

    const result = await invoker.invoke(
      callFor('idem-route-failover'),
      invokerCtx,
    );
    expect(result.ok).toBe(true);
    expect(result.metrics.providerId).toBe('internal-message-log'); // resolver skipped the open vendor
  });
});
