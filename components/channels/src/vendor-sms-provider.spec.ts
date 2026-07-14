import {describe, expect, it} from 'vitest';
import type {DrizzleMessageRepository} from '@platform-internal/drizzle';
import type {OutboundMessage, ProviderExecutionContext, TenantId} from '@platform/contracts';
import {StaticProviderCredentialStore} from './credential-store.js';
import {MESSAGING_REPLY_SEND, type OutboundInput} from './messaging.js';
import type {SmsChannelTransport} from './sms-transport.js';
import {TWILIO_SMS_PROVIDER_ID, VendorSmsProvider} from './vendor-sms-provider.js';

const creds = new StaticProviderCredentialStore({
  [TWILIO_SMS_PROVIDER_ID]: {accountSid: 'AC1', authToken: 'tok', from: '+18885550100'},
});

/** Records outbound persistence for assertions. */
function fakeRepo() {
  const rows: Array<Record<string, unknown>> = [];
  const repo = {
    appendOutbound: async (row: Record<string, unknown>) => {
      rows.push(row);
    },
  } as unknown as DrizzleMessageRepository;
  return {repo, rows};
}

/** A transport whose deliver() succeeds with a fixed SID or throws a scripted error. */
function fakeTransport(behavior: () => Promise<{providerMessageId: string}>) {
  const calls: OutboundMessage[] = [];
  const transport: Pick<SmsChannelTransport, 'deliver'> = {
    deliver: async (msg: OutboundMessage) => {
      calls.push(msg);
      return behavior();
    },
  };
  return {transport, calls};
}

const ctx: ProviderExecutionContext = {
  tenantId: 'tnt_acme' as TenantId,
  capability: MESSAGING_REPLY_SEND,
  idempotencyKey: 'idem-abc',
  config: {},
};
const input: OutboundInput = {to: '+15125559999', body: 'on my way'};

describe('VendorSmsProvider', () => {
  it('delivers via the transport and persists the authoritative row with the vendor SID', async () => {
    const {transport, calls} = fakeTransport(async () => ({providerMessageId: 'SM_real'}));
    const {repo, rows} = fakeRepo();
    const p = new VendorSmsProvider(transport, repo, creds);

    const out = await p.execute(input, ctx);

    expect(out).toEqual({providerMessageId: 'SM_real', status: 'sent'}); // unwrapped output (ADR-018)
    expect(calls[0]!.to).toBe('+15125559999');
    expect(calls[0]!.text).toBe('on my way');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({providerMessageId: 'SM_real', status: 'sent', channel: 'sms'});
  });

  it('does not persist when the vendor send fails, and rethrows the classified error', async () => {
    const {transport} = fakeTransport(async () => {
      throw Object.assign(new Error('boom'), {retryable: true});
    });
    const {repo, rows} = fakeRepo();
    const p = new VendorSmsProvider(transport, repo, creds);

    await expect(p.execute(input, ctx)).rejects.toThrow('boom');
    expect(rows).toHaveLength(0);
  });

  it('opens the circuit after failureThreshold failures, then half-opens after resetMs', async () => {
    let clock = 1_000;
    const {transport} = fakeTransport(async () => {
      throw new Error('vendor down');
    });
    const {repo} = fakeRepo();
    const p = new VendorSmsProvider(transport, repo, creds, {
      circuit: {failureThreshold: 2, resetMs: 1_000},
      nowMs: () => clock,
    });

    expect((await p.status()).circuit).toBe('closed');
    await expect(p.execute(input, ctx)).rejects.toThrow();
    expect((await p.status()).circuit).toBe('closed'); // 1 failure < threshold
    await expect(p.execute(input, ctx)).rejects.toThrow();

    const open = await p.status();
    expect(open.circuit).toBe('open');
    expect(open.health).toBe('unavailable'); // resolver skips it → fails over to internal-message-log

    clock += 1_500; // past resetMs
    const halfOpen = await p.status();
    expect(halfOpen.circuit).toBe('half-open');
    expect(halfOpen.health).toBe('healthy');
  });

  it('recovers (closes) after a successful half-open trial', async () => {
    let clock = 1_000;
    let fail = true;
    const {transport} = fakeTransport(async () => {
      if (fail) throw new Error('down');
      return {providerMessageId: 'SM_ok'};
    });
    const {repo} = fakeRepo();
    const p = new VendorSmsProvider(transport, repo, creds, {
      circuit: {failureThreshold: 1, resetMs: 1_000},
      nowMs: () => clock,
      clock: () => new Date('2026-07-12T00:00:00.000Z'),
    });

    await expect(p.execute(input, ctx)).rejects.toThrow(); // trips open (threshold 1)
    expect((await p.status()).circuit).toBe('open');

    clock += 2_000; // half-open window
    fail = false;
    const out = await p.execute(input, ctx); // successful trial
    expect(out.providerMessageId).toBe('SM_ok');
    expect((await p.status()).circuit).toBe('closed');
  });
});
