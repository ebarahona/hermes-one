import {describe, expect, it} from 'vitest';
import {
  CapabilityContract,
  type CapabilityManifest,
  type CapabilityName,
  type IsoTimestamp,
  type ProviderAdapter,
  type ProviderHealth,
  type CircuitState,
  type Scope,
  type TenantId,
  type ToolCall,
  type ToolCallId,
  type TurnId,
} from '@platform/contracts';
import {InMemoryCapabilityRegistry} from './registry.js';
import {ProviderRegistry} from './provider-registry.js';
import {ProviderResolver, NoProviderError} from './resolver.js';
import {deriveIdempotencyKey} from './idempotency.js';
import {capabilitiesForEngine, scopeSatisfies} from './tools.js';
import {CapabilityInvoker, type InvokeContext} from './invoker.js';

const NOW = '2026-07-11T00:00:00.000Z' as IsoTimestamp;
const CAP = 'sms.message.send' as CapabilityName;

function makeCap(over: Record<string, unknown> = {}): CapabilityContract {
  return CapabilityContract.parse({
    definitionId: 'def_cap_sms',
    kind: 'capability',
    version: '1.0.0',
    contentHash: `sha256:${'a'.repeat(64)}`,
    validatedAt: NOW,
    schemaRef: 'sms-send.capability/v1',
    name: 'sms.message.send',
    title: 'Send SMS',
    description: 'send a text message',
    inputJsonSchema: {type: 'object'},
    outputJsonSchema: {type: 'object'},
    sideEffect: 'external',
    changedDomains: ['messaging', 'conversation'],
    idempotency: {required: true, keyFields: ['to', 'body'], ttlSeconds: 86400},
    confirm: false,
    requiredScope: 'sms.message.send',
    providerMapping: {
      providers: [{providerId: 'twilio', priority: 100}],
      eligibility: [],
      onNoProvider: 'fail',
    },
    ...over,
  });
}

function fakeProvider(
  providerId: string,
  opts: {health?: ProviderHealth; circuit?: CircuitState; output?: unknown; throwErr?: unknown} = {},
): ProviderAdapter {
  return {
    providerId,
    capability: CAP,
    status: async () => ({
      providerId,
      health: opts.health ?? 'healthy',
      circuit: opts.circuit ?? 'closed',
      lastCheckedAt: NOW,
    }),
    execute: async () => {
      if (opts.throwErr) throw opts.throwErr;
      return opts.output ?? {providerMessageId: 'pm_1', status: 'sent'};
    },
  };
}

const call: ToolCall = {
  toolCallId: 'tc_1' as ToolCallId,
  capability: CAP,
  input: {to: '+15125550142', body: 'hi'},
  idempotencyKey: 'trn_1:sms.message.send:"+15125550142":"hi"',
  proposedAt: NOW,
};
const ctx: InvokeContext = {
  turnId: 'trn_1' as TurnId,
  tenantId: 'tnt_a' as TenantId,
  facts: {smsConsent: true},
  now: NOW,
  providerConfig: {},
};

describe('InMemoryCapabilityRegistry', () => {
  it('registers, gets, and lists by manifest', async () => {
    const reg = new InMemoryCapabilityRegistry([makeCap()]);
    expect((await reg.get(CAP, '1.0.0' as never))?.name).toBe('sms.message.send');
    const manifest: CapabilityManifest = {
      entries: [{definitionId: 'def_cap_sms' as never, name: CAP, version: '1.0.0' as never}],
    };
    expect(await reg.list(manifest)).toHaveLength(1);
    expect(await reg.get('a.b.c' as CapabilityName, '9.9.9' as never)).toBeNull();
  });

  it('rejects a mutating capability without required idempotency', async () => {
    const reg = new InMemoryCapabilityRegistry();
    await expect(
      reg.register(makeCap({idempotency: {required: false, keyFields: [], ttlSeconds: 86400}})),
    ).rejects.toThrow(/idempotency/);
  });

  it("rejects a none/read capability whose changedDomains isn't ['none']", async () => {
    const reg = new InMemoryCapabilityRegistry();
    await expect(reg.register(makeCap({sideEffect: 'read', changedDomains: ['messaging']}))).rejects.toThrow(
      /changedDomains/,
    );
  });

  it('seeding with an invalid contract throws synchronously (no unhandled rejection)', () => {
    expect(
      () => new InMemoryCapabilityRegistry([makeCap({idempotency: {required: false, keyFields: [], ttlSeconds: 86400}})]),
    ).toThrow(/idempotency/);
  });
});

describe('ProviderResolver — ranked, eligible, healthy', () => {
  const mapping = (over: Record<string, unknown> = {}) => makeCap({providerMapping: {
    providers: [
      {providerId: 'lo', priority: 50},
      {providerId: 'hi', priority: 100},
    ],
    eligibility: [],
    onNoProvider: 'fail',
    ...over,
  }}).providerMapping;

  it('picks the highest-priority healthy provider', async () => {
    const providers = new ProviderRegistry([fakeProvider('hi'), fakeProvider('lo')]);
    const chosen = await new ProviderResolver(providers).resolve(CAP, mapping(), ctx.facts);
    expect(chosen.providerId).toBe('hi');
  });

  it('falls through to the next provider when the top is unavailable', async () => {
    const providers = new ProviderRegistry([
      fakeProvider('hi', {health: 'unavailable'}),
      fakeProvider('lo'),
    ]);
    const chosen = await new ProviderResolver(providers).resolve(CAP, mapping(), ctx.facts);
    expect(chosen.providerId).toBe('lo');
  });

  it('throws NoProviderError (fail) when an eligibility rule is not met', async () => {
    const providers = new ProviderRegistry([fakeProvider('hi')]);
    const m = mapping({eligibility: [{when: {type: 'fact', path: 'smsConsent'}, reason: 'needs consent'}]});
    await expect(
      new ProviderResolver(providers).resolve(CAP, m, {smsConsent: false}),
    ).rejects.toBeInstanceOf(NoProviderError);
  });

  it('carries onNoProvider=handoff for the caller to route', async () => {
    const providers = new ProviderRegistry(); // none registered
    const m = mapping({onNoProvider: 'handoff'});
    await expect(new ProviderResolver(providers).resolve(CAP, m, ctx.facts)).rejects.toMatchObject({
      onNoProvider: 'handoff',
    });
  });
});

describe('scope-gated tool derivation', () => {
  it('matches scopes segment-wise with wildcards', () => {
    expect(scopeSatisfies(['sms.message.*'] as Scope[], 'sms.message.send' as Scope)).toBe(true);
    expect(scopeSatisfies(['*.*.*'] as Scope[], 'sms.message.send' as Scope)).toBe(true);
    expect(scopeSatisfies(['sms.message.read'] as Scope[], 'sms.message.send' as Scope)).toBe(false);
  });

  it('returns allowed ∩ available, gated by scope', () => {
    const cap = makeCap();
    expect(capabilitiesForEngine([CAP], [cap], ['sms.message.*'] as Scope[])).toHaveLength(1);
    expect(capabilitiesForEngine([CAP], [cap], ['other.thing.read'] as Scope[])).toHaveLength(0);
    expect(capabilitiesForEngine([], [cap], ['*.*.*'] as Scope[])).toHaveLength(0);
  });
});

describe('deriveIdempotencyKey', () => {
  it('composes turnId, name, and keyField values', () => {
    expect(deriveIdempotencyKey(makeCap(), {to: '+1', body: 'hi'}, 'trn_1')).toBe(
      'trn_1:sms.message.send:"+1":"hi"',
    );
  });
});

describe('CapabilityInvoker — resolves + executes + envelopes', () => {
  const invoker = (providers: ProviderRegistry, cap = makeCap()) =>
    new CapabilityInvoker(() => cap, new ProviderResolver(providers));

  it('synthesizes an ok ToolResult with provider evidence and contract metadata', async () => {
    const res = await invoker(new ProviderRegistry([fakeProvider('twilio')])).invoke(call, ctx);
    expect(res.ok).toBe(true);
    expect((res.output as {providerMessageId: string}).providerMessageId).toBe('pm_1');
    expect(res.sideEffect).toBe('external');
    expect(res.stateChanged).toBe(true);
    expect(res.changedDomains).toEqual(['messaging', 'conversation']);
    expect(res.evidence[0].kind).toBe('tool-output');
    // ADR-028: an invoked capability's tool-output is authoritative/trusted (trusted:false is the
    // RETRIEVED-content injection defense); ADR-009 composition grounds only on trusted evidence.
    expect(res.evidence[0].source).toBe('authoritative');
    expect(res.evidence[0].trusted).toBe(true);
    expect(res.metrics.providerId).toBe('twilio');
  });

  // CT3: the tenant's provider_mappings override outranks the contract default at INVOCATION time —
  // and absence of an override row means the contract default (table-catalog.md).
  it('a tenant provider-mapping override wins over the contract default; absence falls back', async () => {
    const providers = new ProviderRegistry([fakeProvider('twilio'), fakeProvider('bandwidth')]);
    // Contract default ranks twilio first (makeCap). The override flips the ranking to bandwidth.
    const override = {
      providers: [
        {providerId: 'bandwidth', priority: 200},
        {providerId: 'twilio', priority: 100},
      ],
      eligibility: [],
      onNoProvider: 'fail' as const,
    };
    const overridden = new CapabilityInvoker(() => makeCap(), new ProviderResolver(providers), async () => override);
    expect((await overridden.invoke(call, ctx)).metrics.providerId).toBe('bandwidth');

    const absent = new CapabilityInvoker(() => makeCap(), new ProviderResolver(providers), async () => null);
    expect((await absent.invoke(call, ctx)).metrics.providerId).toBe('twilio');
  });

  it('maps a provider execution failure to an ok:false ToolResult', async () => {
    const providers = new ProviderRegistry([
      fakeProvider('twilio', {throwErr: {code: 'provider_rejected', message: 'blocked', retryable: false}}),
    ]);
    const res = await invoker(providers).invoke(call, ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('provider_rejected');
  });

  it('propagates NoProviderError (never swallows the handoff/fail decision)', async () => {
    await expect(invoker(new ProviderRegistry()).invoke(call, ctx)).rejects.toBeInstanceOf(NoProviderError);
  });
});
