import {describe, expect, it} from 'vitest';
import {createHmac} from 'node:crypto';
import {
  PlatformErrorException,
  SecretRef,
  type ConversationId,
  type OutboundMessage,
  type ProviderExecutionContext,
  type SecretProvider,
  type TenantId,
} from '@platform/contracts';
import type {NonceStore} from '@platform-internal/redis';
import {
  SmsChannelTransport,
  smsSignedMaterial,
  type FetchLike,
  type SmsTransportConfig,
} from './sms-transport.js';

const SECRET = 'shh';
const NOW = '2026-07-12T00:00:00.000Z';
const NOW_S = Math.floor(Date.parse(NOW) / 1000);
const sign = (body: string, ts: string) =>
  createHmac('sha256', SECRET)
    .update(smsSignedMaterial(body, ts))
    .digest('hex');

const makeTransport = (over: Partial<SmsTransportConfig> = {}) =>
  new SmsChannelTransport({
    signingSecret: SECRET,
    signatureHeader: 'x-signature',
    tenantByNumber: to =>
      to === '+15125550100' ? ('tnt_acme' as TenantId) : null,
    clock: () => NOW,
    ...over,
  });
const transport = makeTransport();

const raw = (parsed: Record<string, string>, ts: string = String(NOW_S)) => {
  const rawBody = JSON.stringify(parsed);
  return {
    rawWebhook: {rawBody, parsed},
    headers: {'x-signature': sign(rawBody, ts), 'x-timestamp': ts},
  };
};

describe('SmsChannelTransport.ingest (AUTH-1 verification ladder)', () => {
  it('verifies the signature and normalizes to an InboundMessage', async () => {
    const {rawWebhook, headers} = raw({
      From: '+15125559999',
      To: '+15125550100',
      Body: 'help',
      MessageSid: 'SM1',
    });
    const msg = await transport.ingest(rawWebhook, headers);
    expect(msg).not.toBeNull();
    expect(msg!.tenantId).toBe('tnt_acme');
    expect(msg!.channel).toBe('sms');
    expect(msg!.from).toBe('+15125559999');
    expect(msg!.text).toBe('help');
    expect(msg!.providerMessageId).toBe('SM1');
  });

  it('rejects a forged request (bad signature)', async () => {
    const {rawWebhook, headers} = raw({
      From: '+1',
      To: '+15125550100',
      Body: 'x',
      MessageSid: 'SM2',
    });
    await expect(
      transport.ingest(rawWebhook, {...headers, 'x-signature': 'deadbeef'}),
    ).rejects.toThrow(/signature/);
  });

  it('rejects a missing timestamp (timestamp is part of the contract, not optional)', async () => {
    const {rawWebhook, headers} = raw({
      From: '+1',
      To: '+15125550100',
      Body: 'x',
      MessageSid: 'SM2a',
    });
    const {['x-timestamp']: _ts, ...withoutTs} = headers;
    await expect(transport.ingest(rawWebhook, withoutTs)).rejects.toThrow(
      /signature/,
    );
  });

  it('rejects a stale timestamp BEFORE any HMAC work (skew window, default 300s)', async () => {
    const stale = String(NOW_S - 301);
    const {rawWebhook, headers} = raw(
      {From: '+1', To: '+15125550100', Body: 'x', MessageSid: 'SM2b'},
      stale,
    );
    await expect(transport.ingest(rawWebhook, headers)).rejects.toThrow(
      /timestamp/,
    );
  });

  it('the timestamp is INSIDE the signed material — resigning the body alone fails', async () => {
    const parsed = {
      From: '+1',
      To: '+15125550100',
      Body: 'x',
      MessageSid: 'SM2c',
    };
    const rawBody = JSON.stringify(parsed);
    const bodyOnlySig = createHmac('sha256', SECRET)
      .update(rawBody)
      .digest('hex'); // pre-AUTH-1 material
    await expect(
      transport.ingest(
        {rawBody, parsed},
        {'x-signature': bodyOnlySig, 'x-timestamp': String(NOW_S)},
      ),
    ).rejects.toThrow(/signature/);
  });

  it('rejects a REPLAY: the same signature is single-use within the skew window', async () => {
    const seen = new Set<string>();
    const nonces: NonceStore = {
      reserve: async key => (seen.has(key) ? false : (seen.add(key), true)),
    };
    const guarded = makeTransport({nonces});
    const {rawWebhook, headers} = raw({
      From: '+15125559999',
      To: '+15125550100',
      Body: 'hi',
      MessageSid: 'SM2d',
    });
    expect(await guarded.ingest(rawWebhook, headers)).not.toBeNull();
    await expect(guarded.ingest(rawWebhook, headers)).rejects.toThrow(/replay/);
  });

  it('reserves the nonce for the FULL validity window (2×skew) — a future-dated timestamp cannot outlive it', async () => {
    const reserved: number[] = [];
    const nonces: NonceStore = {
      reserve: async (_key, ttlSeconds) => (reserved.push(ttlSeconds), true),
    };
    const guarded = makeTransport({nonces, skewWindowSeconds: 120});
    // Vendor clock ahead by the full skew: signature stays valid until ts+skew = now+2×skew.
    const future = String(NOW_S + 120);
    const {rawWebhook, headers} = raw(
      {
        From: '+15125559999',
        To: '+15125550100',
        Body: 'hi',
        MessageSid: 'SM2g',
      },
      future,
    );
    expect(await guarded.ingest(rawWebhook, headers)).not.toBeNull();
    expect(reserved).toEqual([240]); // 2 * skewWindowSeconds — never just skew
  });

  it('resolves the signing secret through the SecretRef seam (rotation-ready)', async () => {
    let resolved = 0;
    const secrets: SecretProvider = {
      resolve: async () => (
        resolved++,
        {value: SECRET, version: 'v1', resolvedAt: NOW}
      ),
      invalidate: () => {},
    };
    const viaRef = makeTransport({
      signingSecret: undefined,
      signingSecretRef: SecretRef.parse('secret://webhooks/acme/signing'),
      secrets,
    });
    const {rawWebhook, headers} = raw({
      From: '+1',
      To: '+15125550100',
      Body: 'x',
      MessageSid: 'SM2e',
    });
    expect(await viaRef.ingest(rawWebhook, headers)).not.toBeNull();
    expect(resolved).toBe(1);
  });

  it('fails closed when no signing secret is configured at all', async () => {
    const none = makeTransport({signingSecret: undefined});
    const {rawWebhook, headers} = raw({
      From: '+1',
      To: '+15125550100',
      Body: 'x',
      MessageSid: 'SM2f',
    });
    await expect(none.ingest(rawWebhook, headers)).rejects.toThrow(
      /no webhook signing secret/,
    );
  });

  it('drops a message to a number no tenant owns', async () => {
    const {rawWebhook, headers} = raw({
      From: '+1',
      To: '+19999999999',
      Body: 'x',
      MessageSid: 'SM3',
    });
    expect(await transport.ingest(rawWebhook, headers)).toBeNull();
  });
});

const outbound: OutboundMessage = {
  tenantId: 'tnt_acme' as TenantId,
  channel: 'sms',
  conversationId: 'cnv_1' as ConversationId,
  to: '+15125559999',
  text: 'hello',
  attachments: [],
  idempotencyKey: 'idem-1',
};
const ctx: ProviderExecutionContext = {
  tenantId: 'tnt_acme' as TenantId,
  capability: 'messaging.reply.send' as ProviderExecutionContext['capability'],
  idempotencyKey: 'idem-1',
  config: {accountSid: 'AC123', authToken: 'tok', from: '+18885550100'},
};

const deliverTransport = (fetchImpl: FetchLike) =>
  new SmsChannelTransport({
    signingSecret: SECRET,
    signatureHeader: 'x-signature',
    tenantByNumber: () => null,
    vendorBaseUrl: 'https://fake-twilio.test',
    timeoutMs: 5000,
    fetchImpl,
  });
const res = (status: number, body: unknown): ReturnType<FetchLike> =>
  Promise.resolve({
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });

describe('SmsChannelTransport.deliver (outcome mapping)', () => {
  it('posts to the vendor and returns the SID on 2xx', async () => {
    let seen:
      {url: string; body: string; auth?: string; idem?: string} | undefined;
    const t = deliverTransport(async (url, init) => {
      seen = {
        url,
        body: init.body,
        auth: init.headers.authorization,
        idem: init.headers['idempotency-key'],
      };
      return res(201, {sid: 'SMabc'});
    });
    const out = await t.deliver(outbound, ctx);
    expect(out.providerMessageId).toBe('SMabc');
    expect(seen!.url).toBe(
      'https://fake-twilio.test/2010-04-01/Accounts/AC123/Messages.json',
    );
    expect(seen!.body).toContain('To=%2B15125559999');
    expect(seen!.body).toContain('From=%2B18885550100');
    expect(seen!.auth).toBe(
      `Basic ${Buffer.from('AC123:tok').toString('base64')}`,
    );
    // Best-effort vendor idempotency token rides on every send.
    expect(seen!.idem).toBe('idem-1');
  });

  it('maps a 5xx to a retryable infrastructure error', async () => {
    const t = deliverTransport(async () => res(503, {message: 'overloaded'}));
    await expect(t.deliver(outbound, ctx)).rejects.toMatchObject({
      error: {
        category: 'infrastructure',
        code: 'infrastructure_error',
        retryable: true,
      },
    });
  });

  it('maps a 4xx business rejection to a non-retryable provider error', async () => {
    const t = deliverTransport(async () =>
      res(400, {message: 'invalid number'}),
    );
    await expect(t.deliver(outbound, ctx)).rejects.toMatchObject({
      error: {
        category: 'provider',
        code: 'provider_rejected',
        retryable: false,
      },
    });
  });

  it('maps a network failure to a retryable infrastructure error', async () => {
    const t = deliverTransport(async () =>
      Promise.reject(new Error('ECONNRESET')),
    );
    await expect(t.deliver(outbound, ctx)).rejects.toMatchObject({
      error: {code: 'infrastructure_error', retryable: true},
    });
  });

  it('maps a timeout (abort) to a retryable timeout error', async () => {
    // A fetch that never resolves until the transport's AbortController fires at timeoutMs.
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        }),
      );
    const t = new SmsChannelTransport({
      signingSecret: SECRET,
      signatureHeader: 'x-signature',
      tenantByNumber: () => null,
      vendorBaseUrl: 'https://fake-twilio.test',
      timeoutMs: 5,
      fetchImpl: hang,
    });
    await expect(t.deliver(outbound, ctx)).rejects.toMatchObject({
      error: {category: 'timeout', code: 'deadline_exceeded', retryable: true},
    });
  });

  it('fails closed (non-retryable) when credentials are incomplete', async () => {
    const t = deliverTransport(async () => res(201, {sid: 'SMx'}));
    await expect(
      t.deliver(outbound, {...ctx, config: {accountSid: 'AC123'}}),
    ).rejects.toBeInstanceOf(PlatformErrorException);
  });
});
