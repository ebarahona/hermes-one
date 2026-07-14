// SmsChannelTransport (edge plane): the inbound + outbound seam for SMS. `ingest` verifies the vendor's
// HMAC signature over the raw request body (reject on mismatch — indirect-injection / spoofing defense)
// and normalizes the provider payload into a vendor-neutral InboundMessage. The destination number
// resolves the tenant (a signed webhook can only reach a tenant that owns that number). `deliver` makes
// the REAL vendor send: an HTTP POST to the Twilio Messages API, authenticated with the tenant's secret
// bundle (ctx.config — resolved via a ProviderCredentialStore, never inline), classifying failures onto
// the platform error taxonomy (5xx/network/timeout → infrastructure_error retryable; 4xx business →
// provider_rejected non-retryable — provider-contracts.md outcome mapping). parseReceipt/isOptedOut stay
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
  type TenantId,
} from '@platform/contracts';

/** Minimal fetch seam (Node 22 global fetch by default; injected in tests). */
export type FetchLike = (
  url: string,
  init: {method: string; headers: Record<string, string>; body: string; signal: AbortSignal},
) => Promise<{status: number; text(): Promise<string>; json(): Promise<unknown>}>;

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
  /** Shared secret the vendor signs the raw body with (HMAC-SHA256). */
  signingSecret: string;
  /** Header carrying the hex signature (e.g. 'x-signature'). */
  signatureHeader: string;
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

export class SmsChannelTransport implements ChannelTransport {
  readonly channel = 'sms' as const;
  readonly transportClass = 'channel' as const;

  constructor(private readonly cfg: SmsTransportConfig) {}

  private verify(rawBody: string, headers: Record<string, string>): boolean {
    const provided = headers[this.cfg.signatureHeader] ?? headers[this.cfg.signatureHeader.toLowerCase()];
    if (!provided) return false;
    const expected = createHmac('sha256', this.cfg.signingSecret).update(rawBody).digest('hex');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Verify + normalize. `rawWebhook` is `{rawBody, parsed}` — the raw string is what the signature covers;
   * the parsed object is the vendor JSON/form. Returns null to DROP (unknown destination / not our tenant);
   * throws on a signature mismatch (a forged request must never reach the workflow).
   */
  async ingest(
    rawWebhook: {rawBody: string; parsed: RawSmsWebhook},
    headers: Record<string, string>,
  ): Promise<InboundMessage | null> {
    if (!this.verify(rawWebhook.rawBody, headers)) {
      throw new Error('SMS webhook signature verification failed');
    }
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
   * inline. Outcome mapping (provider-contracts.md): 5xx / network / timeout → infrastructure_error
   * (retryable); a 4xx business rejection → provider_rejected (non-retryable); 2xx → the vendor SID.
   */
  async deliver(
    msg: OutboundMessage,
    ctx: ProviderExecutionContext,
  ): Promise<{providerMessageId: string}> {
    const {accountSid, authToken, from} = ctx.config;
    if (!accountSid || !authToken || !from) {
      // A misconfigured tenant credential bundle is not retryable — fail closed, do not send blind.
      throw platformError('validation', 'validation_failed', 'sms provider credentials incomplete', false);
    }

    const baseUrl = this.cfg.vendorBaseUrl ?? DEFAULT_VENDOR_BASE_URL;
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const doFetch = this.cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const url = `${baseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
    const body = new URLSearchParams({To: msg.to, From: from, Body: msg.text}).toString();
    const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: {status: number; text(): Promise<string>; json(): Promise<unknown>};
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          authorization: auth,
          'content-type': 'application/x-www-form-urlencoded',
          // Best-effort vendor idempotency token (retry-policy-registry.md `delivery`): Twilio's
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
        aborted ? `sms vendor request timed out after ${timeoutMs}ms` : `sms vendor request failed: ${(err as Error).message}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 500) {
      throw platformError('infrastructure', 'infrastructure_error', `sms vendor ${res.status}`, true);
    }
    if (res.status >= 400) {
      const detail = await res.text().catch(() => '');
      throw platformError('provider', 'provider_rejected', `sms vendor rejected (${res.status}): ${detail}`, false);
    }
    const json = (await res.json()) as {sid?: string};
    if (!json.sid) {
      throw platformError('provider', 'provider_rejected', 'sms vendor response missing sid', false);
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
