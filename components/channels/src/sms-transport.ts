// SmsChannelTransport (edge plane): the inbound + outbound seam for SMS. `ingest` verifies the vendor's
// HMAC signature over the raw request body (reject on mismatch — indirect-injection / spoofing defense)
// and normalizes the provider payload into a vendor-neutral InboundMessage. The destination number
// resolves the tenant (a signed webhook can only reach a tenant that owns that number). `deliver` makes
// the REAL vendor send: an HTTP POST to the Twilio Messages API, authenticated with the tenant's secret
// bundle (ctx.config — resolved via a ProviderCredentialStore, never inline), classifying failures onto
// the platform error taxonomy (5xx/network/timeout → infrastructure_error retryable; 4xx business →
// provider_rejected non-retryable — outcome mapping). parseReceipt/isOptedOut stay
// minimal (flagged: a full receipt-webhook + STOP/HELP ledger is a later build).
import {createHmac, timingSafeEqual} from 'node:crypto';
import {
  HTTP_STATUS_BY_CODE,
  PlatformErrorException,
  type ChannelTransport,
  type DeliveryReceipt,
  type ErrorCategory,
  type ErrorCode,
  type InboundMessage,
  type OutboundMessage,
  type ProviderExecutionContext,
  type SecretProvider,
  type SecretRef,
  type TenantId,
} from '@hermes-one/contracts';
import type {NonceStore} from '@hermes-one/redis';

/** Minimal fetch seam (Node 22 global fetch by default; injected in tests). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

/** Resolve which tenant owns an inbound destination handle (e.g. the To phone number). */
export type TenantByNumber = (to: string) => TenantId | null;

/** Raw provider SMS webhook fields we read (Twilio-shaped; other vendors map here). */
interface RawSmsWebhook {
  From?: string;
  To?: string;
  Body?: string;
  MessageSid?: string;
}

export interface SmsTransportConfig {
  /** Inline shared secret (dev/tests). Production resolves `signingSecretRef` instead (AUTH-1). */
  signingSecret?: string;
  /** `secret://` pointer to the signing secret — wins over `signingSecret` when both are set. */
  signingSecretRef?: SecretRef;
  /** Resolves `signingSecretRef` (EnvSecretProvider in dev; cloud secret manager in prod). */
  secrets?: SecretProvider;
  /** Header carrying the hex signature (e.g. 'x-signature'). */
  signatureHeader: string;
  /** Header carrying the unix-seconds timestamp signed into the material (default 'x-timestamp'). */
  timestampHeader?: string;
  /** Max |now - timestamp| accepted, seconds. */
  skewWindowSeconds?: number;
  /** Replay guard (Redis setNX). When present, an already-seen signature is rejected (AUTH-1).
   *  Absence = guard off (dev/tests) — flagged; production wires RedisNonceStore. */
  nonces?: NonceStore;
  tenantByNumber: TenantByNumber;
  clock?: () => string;
  /** Vendor API base (non-secret). Default Twilio; overridable for a self-hosted proxy/fake. */
  vendorBaseUrl?: string;
  /** Per-request deadline (ProviderAdapterConfig.timeoutMs default 10000). */
  timeoutMs?: number;
  /** Injected fetch for testing; defaults to the Node global. */
  fetchImpl?: FetchLike;
}

const DEFAULT_VENDOR_BASE_URL = 'https://api.twilio.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TIMESTAMP_HEADER = 'x-timestamp';
const DEFAULT_SKEW_WINDOW_SECONDS = 300;

/** Signed material (AUTH-1): the timestamp is INSIDE the HMAC so it cannot be replayed-with-edit. */
export const smsSignedMaterial = (rawBody: string, timestamp: string): string =>
  `${rawBody}.${timestamp}`;

export class SmsChannelTransport implements ChannelTransport {
  readonly channel = 'sms' as const;
  readonly transportClass = 'channel' as const;

  constructor(private readonly cfg: SmsTransportConfig) {}

  private async signingSecretValue(): Promise<string> {
    if (this.cfg.signingSecretRef) {
      if (!this.cfg.secrets)
        throw new Error('signingSecretRef configured without a SecretProvider');
      return (await this.cfg.secrets.resolve(this.cfg.signingSecretRef)).value;
    }
    if (this.cfg.signingSecret) return this.cfg.signingSecret;
    throw new Error('no webhook signing secret configured'); // fail-closed, never verify against ''
  }

  private header(
    headers: Record<string, string>,
    name: string,
  ): string | undefined {
    return headers[name] ?? headers[name.toLowerCase()];
  }

  /**
   * AUTH-1 verification ladder:
   * 1. timestamp present and within the skew window (no HMAC work on stale requests);
   * 2. constant-time HMAC over `rawBody + '.' + timestamp` (timestamp inside the signed material);
   * 3. replay guard — the signature is single-use within the skew window (Redis setNX).
   */
  private async verify(
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<void> {
    const provided = this.header(headers, this.cfg.signatureHeader);
    const timestamp = this.header(
      headers,
      this.cfg.timestampHeader ?? DEFAULT_TIMESTAMP_HEADER,
    );
    if (!provided || !timestamp)
      throw new Error('SMS webhook signature verification failed');

    const skewSeconds =
      this.cfg.skewWindowSeconds ?? DEFAULT_SKEW_WINDOW_SECONDS;
    const nowMs = Date.parse(
      (this.cfg.clock ?? (() => new Date().toISOString()))(),
    );
    const tsMs = Number(timestamp) * 1000;
    if (!Number.isFinite(tsMs) || Math.abs(nowMs - tsMs) > skewSeconds * 1000) {
      throw new Error('SMS webhook timestamp outside the accepted window');
    }

    const secret = await this.signingSecretValue();
    const expected = createHmac('sha256', secret)
      .update(smsSignedMaterial(rawBody, timestamp))
      .digest('hex');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error('SMS webhook signature verification failed');
    }

    if (this.cfg.nonces) {
      // TTL = 2×skew, not skew: a future-dated timestamp (vendor clock ahead by up to skew) stays
      // signature-valid until ts+skew — up to 2×skew from now. The nonce must outlive the FULL
      // remaining validity window or a captured request replays clean after the nonce expires.
      const fresh = await this.cfg.nonces.reserve(
        `sms:${provided}`,
        2 * skewSeconds,
      );
      if (!fresh) throw new Error('SMS webhook replay detected');
    }
  }

  /**
   * Verify + normalize. `rawWebhook` is `{rawBody, parsed}` — the raw string is what the signature covers;
   * the parsed object is the vendor JSON/form. Returns null to DROP (unknown destination / not our tenant);
   * throws on a failed verification ladder (a forged/stale/replayed request must never reach the workflow).
   */
  async ingest(
    rawWebhook: {rawBody: string; parsed: RawSmsWebhook},
    headers: Record<string, string>,
  ): Promise<InboundMessage | null> {
    await this.verify(rawWebhook.rawBody, headers);
    const p = rawWebhook.parsed;
    if (!p.To || !p.From || !p.MessageSid) return null; // malformed → drop
    const tenantId = this.cfg.tenantByNumber(p.To);
    if (!tenantId) return null; // no tenant owns this number → drop (not ours)

    const now = (this.cfg.clock ?? (() => new Date().toISOString()))();
    return {
      tenantId,
      channel: 'sms',
      conversationId: null,
      from: p.From,
      to: p.To,
      text: p.Body,
      attachments: [],
      providerMessageId: p.MessageSid,
      receivedAt: now as InboundMessage['receivedAt'],
      providerMeta: {...p},
    } as InboundMessage;
  }

  /**
   * Deliver an outbound SMS through the Twilio Messages API. Credentials (accountSid/authToken/from)
   * arrive in `ctx.config` — resolved from the provider's configKey by a ProviderCredentialStore, never
   * inline. Outcome mapping: 5xx / network / timeout → infrastructure_error
   * (retryable); a 4xx business rejection → provider_rejected (non-retryable); 2xx → the vendor SID.
   */
  async deliver(
    msg: OutboundMessage,
    ctx: ProviderExecutionContext,
  ): Promise<{providerMessageId: string}> {
    const {accountSid, authToken, from} = ctx.config;
    if (!accountSid || !authToken || !from) {
      // A misconfigured tenant credential bundle is not retryable — fail closed, do not send blind.
      throw platformError(
        'validation',
        'validation_failed',
        'sms provider credentials incomplete',
        false,
      );
    }

    const baseUrl = this.cfg.vendorBaseUrl ?? DEFAULT_VENDOR_BASE_URL;
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const doFetch =
      this.cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const url = `${baseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
    const body = new URLSearchParams({
      To: msg.to,
      From: from,
      Body: msg.text,
    }).toString();
    const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: {
      status: number;
      text(): Promise<string>;
      json(): Promise<unknown>;
    };
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          authorization: auth,
          'content-type': 'application/x-www-form-urlencoded',
          // Best-effort vendor idempotency token: Twilio's
          // Messages API does not document honoring it (flagged) — the real duplicate-send guard is
          // the `non-idempotent-guarded-write` class's maximumAttempts:1; this header lets a vendor
          // or proxy that DOES dedupe collapse an accidental resend.
          'idempotency-key': msg.idempotencyKey,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      // Network failure or the timeout abort — retryable infrastructure error.
      const aborted = (err as Error).name === 'AbortError';
      throw platformError(
        aborted ? 'timeout' : 'infrastructure',
        aborted ? 'deadline_exceeded' : 'infrastructure_error',
        aborted
          ? `sms vendor request timed out after ${timeoutMs}ms`
          : `sms vendor request failed: ${(err as Error).message}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 500) {
      throw platformError(
        'infrastructure',
        'infrastructure_error',
        `sms vendor ${res.status}`,
        true,
      );
    }
    if (res.status >= 400) {
      const detail = await res.text().catch(() => '');
      throw platformError(
        'provider',
        'provider_rejected',
        `sms vendor rejected (${res.status}): ${detail}`,
        false,
      );
    }
    const json = (await res.json()) as {sid?: string};
    if (!json.sid) {
      throw platformError(
        'provider',
        'provider_rejected',
        'sms vendor response missing sid',
        false,
      );
    }
    return {providerMessageId: json.sid};
  }

  // Receipt + opt-out are not the focus of this build; minimal honest impls (flagged: a full async
  // delivery-receipt webhook + STOP/HELP opt-out ledger is a later build).
  async parseReceipt(): Promise<DeliveryReceipt | null> {
    return null;
  }
  async isOptedOut(): Promise<boolean> {
    return false;
  }
}

/** Build a throwable PlatformError the CapabilityInvoker unwraps into an ok:false ToolResult. */
function platformError(
  category: ErrorCategory,
  code: ErrorCode,
  message: string,
  retryable: boolean,
): PlatformErrorException {
  return new PlatformErrorException({
    category,
    code,
    message,
    issues: [],
    retryable,
    httpStatus: HTTP_STATUS_BY_CODE[code],
  });
}
