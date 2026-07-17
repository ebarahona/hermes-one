// Centralized, Zod-validated, env-driven configuration (the platform is
// configuration-driven). `loadConfig` is a PURE function of the environment —
// no global mutable singleton; callers load once at their composition root and
// inject it. Invalid config fails loud at boot (fail-closed).
//
// Dev defaults match infra/docker-compose.yml so a fresh clone runs locally with
// zero env; production overrides every value via environment variables.
import {z} from 'zod';

// Connections only, expressed by ROLE — never by vendor. Consumers depend on
// ports (PlanStore, …); the composition root is the single place that maps a
// role's connection URL to a concrete adapter (Drizzle/Postgres today, a Mongo
// or other adapter tomorrow — a wiring change, not a config-shape change). The
// URL scheme carries the driver for that composition root.
//
// Task-queue names are compile-time identifiers the Temporal workflow references,
// and workflow code cannot read env (deterministic sandbox) — so those live as
// code constants (apps/*/queues), not here.
const StoreConn = z.object({url: z.string().min(1)});

export const HermesConfig = z.object({
  temporal: z.object({
    address: z.string().min(1), // host:port of the Temporal frontend
    namespace: z.string().min(1),
  }),
  stores: z.object({
    authoritative: StoreConn, // where authoritative state + compiled plans live
    ephemeral: StoreConn, // cache / idempotency / locks / debounce / pub-sub
    vector: StoreConn, // embeddings
  }),
  llm: z.object({
    baseUrl: z.string().url(), // OpenAI-compatible base, e.g. llama-server /v1
    model: z.string().min(1),
    apiKey: z.string().min(1), // dummy for local servers; a real secret in prod
  }),
  // Optional outbound SMS vendor. Absent → the capability plane falls back to the internal message-log
  // provider (persist-only). Present with creds → the real VendorSmsProvider is registered ahead of it.
  // The creds enter here from the environment (like llm.apiKey) and are handed to the credential-store
  // seam at the composition root — never into a definition body. Real per-tenant resolution is the
  // security/secrets-and-key-management.md KMS store (flagged in credential-store.ts).
  sms: z
    .object({
      vendor: z.literal('twilio'),
      accountSid: z.string().min(1),
      authToken: z.string().min(1),
      from: z.string().min(1),
      baseUrl: z.string().url().optional(), // override the Twilio base (self-hosted proxy / test fake)
      timeoutMs: z.coerce.number().int().min(100).optional(),
    })
    .optional(),
  // Tenant provider-credential encryption (ADR-026). When the master key is present, composition
  // roots layer the envelope store (per-tenant rows) over the static env bundle; absent → static
  // only. The key is 32 bytes hex and NEVER leaves the composition root.
  credentials: z.object({masterKey: z.string().regex(/^[0-9a-f]{64}$/i)}).optional(),
  // Transactional-outbox publisher (events/event-envelope.md EventEnvelopeConfig). The loop drains
  // per tenant under RLS — the tenant list is a config stand-in until the tenant registry exists
  // (CT1/CT2; the cross-tenant relay role is an unresolved spec question). Empty tenants → loop off.
  outbox: z.object({
    pollIntervalMs: z.coerce.number().int().min(100),
    maxAttempts: z.coerce.number().int().min(1),
    channelPattern: z.string().min(1),
    tenants: z.array(z.string().min(1)),
  }),
  // Edge REST surface (loopback/application-bootstrap.md — admin-api/api-gateway listen port). The
  // LB4 RestApplication root binds this into `rest: {port}`. Version prefix + pagination live with the
  // api layer (rest-api-reference.md EdgeApiConfig) — this only carries where the process listens.
  api: z.object({
    port: z.coerce.number().int().min(1).max(65535), // admin-api HTTP listen port
  }),
  // OpenTelemetry distributed tracing (observability/tracing-metrics-logging.md, OB5). `mode` selects the
  // span exporter: off → NoopTracer (unit/dev quiet); console → stdout (dev); otlp → ship to a collector
  // (prod). `endpoint` is the OTLP/HTTP traces URL used when mode==='otlp'. Structured logs + metrics
  // already emit regardless; this drives the trace pillar only.
  otel: z.object({
    mode: z.enum(['off', 'console', 'otlp']),
    endpoint: z.string().url(),
  }),
});
export type HermesConfig = z.infer<typeof HermesConfig>;

/** Env var name → local-dev default (matches infra/docker-compose.yml). */
const DEFAULTS = {
  TEMPORAL_ADDRESS: '127.0.0.1:7233',
  TEMPORAL_NAMESPACE: 'default',
  HERMES_AUTHORITATIVE_URL: 'postgres://hermes:hermes@127.0.0.1:5433/hermes',
  HERMES_EPHEMERAL_URL: 'redis://127.0.0.1:6380',
  HERMES_VECTOR_URL: 'http://127.0.0.1:6333',
  LLM_BASE_URL: 'http://127.0.0.1:8080/v1',
  LLM_MODEL: 'qwen3-coder-next-80b', // local llama-server model; override via LLM_MODEL
  LLM_API_KEY: 'local',
  HERMES_OUTBOX_POLL_MS: '1000', // EventEnvelopeConfig.outboxPollIntervalMs default
  HERMES_OUTBOX_MAX_ATTEMPTS: '10', // EventEnvelopeConfig.outboxMaxAttempts default
  HERMES_OUTBOX_CHANNEL_PATTERN: 'events:{tenantId}:{aggregateType}',
  HERMES_OUTBOX_TENANTS: '', // csv; empty → publisher loop disabled
  HERMES_ADMIN_API_PORT: '3001', // edge REST listen port (admin-api)
  HERMES_OTEL_TRACES: 'off', // off | console | otlp
  HERMES_OTEL_ENDPOINT: 'http://127.0.0.1:4318/v1/traces', // OTLP/HTTP traces (matches infra collector)
} as const;

/**
 * Load + validate config from the environment. Throws a ZodError with the
 * offending path if any value is missing/malformed (fail-closed).
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): HermesConfig {
  const g = (k: keyof typeof DEFAULTS): string => env[k] ?? DEFAULTS[k];
  // Vendor SMS is opt-in: only assembled when a vendor is named (all creds then required by the schema).
  const credentials = env.HERMES_CREDENTIALS_MASTER_KEY
    ? {masterKey: env.HERMES_CREDENTIALS_MASTER_KEY}
    : undefined;
  const sms = env.SMS_VENDOR
    ? {
        vendor: env.SMS_VENDOR,
        accountSid: env.SMS_ACCOUNT_SID,
        authToken: env.SMS_AUTH_TOKEN,
        from: env.SMS_FROM,
        baseUrl: env.SMS_BASE_URL,
        timeoutMs: env.SMS_TIMEOUT_MS,
      }
    : undefined;
  return HermesConfig.parse({
    temporal: {
      address: g('TEMPORAL_ADDRESS'),
      namespace: g('TEMPORAL_NAMESPACE'),
    },
    stores: {
      authoritative: {url: g('HERMES_AUTHORITATIVE_URL')},
      ephemeral: {url: g('HERMES_EPHEMERAL_URL')},
      vector: {url: g('HERMES_VECTOR_URL')},
    },
    llm: {
      baseUrl: g('LLM_BASE_URL'),
      model: g('LLM_MODEL'),
      apiKey: g('LLM_API_KEY'),
    },
    sms,
    credentials,
    outbox: {
      pollIntervalMs: g('HERMES_OUTBOX_POLL_MS'),
      maxAttempts: g('HERMES_OUTBOX_MAX_ATTEMPTS'),
      channelPattern: g('HERMES_OUTBOX_CHANNEL_PATTERN'),
      tenants: g('HERMES_OUTBOX_TENANTS').split(',').map(t => t.trim()).filter(Boolean),
    },
    api: {
      port: g('HERMES_ADMIN_API_PORT'),
    },
    otel: {
      mode: g('HERMES_OTEL_TRACES'),
      endpoint: g('HERMES_OTEL_ENDPOINT'),
    },
  });
}
