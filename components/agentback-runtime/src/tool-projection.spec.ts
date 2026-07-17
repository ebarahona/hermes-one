// tool-projection.md Testing Strategy — the rows this slice can assert hermetically (no live stack).
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import type {CapabilityContract, ProviderAdapter} from '@platform/contracts';
import {
  CapabilityToolProjector,
  autonomousProjectionEnabled,
  type ProjectionContext,
} from './tool-projection.js';
import {jsonSchemaToZod, UnsupportedSchemaError} from './json-schema-to-zod.js';

const SLOT_READ = {
  name: 'appointment.slot.read',
  title: 'Read appointment slots',
  description: 'List open service-visit slots for a given date and service type.',
  inputJsonSchema: {
    type: 'object',
    required: ['date'],
    properties: {date: {type: 'string'}, serviceType: {type: 'string'}},
  },
  outputJsonSchema: {type: 'object', properties: {slots: {type: 'array'}}},
  sideEffect: 'read',
  changedDomains: ['none'],
  idempotency: {required: false, keyFields: [], ttlSeconds: 86400},
  confirm: false,
  requiredScope: 'appointment.slot.read',
  providerMapping: {
    providers: [{providerId: 'internal-scheduler', priority: 100}],
    eligibility: [],
    onNoProvider: 'fail',
  },
} as unknown as CapabilityContract;

const BOOKING_CREATE = {
  ...SLOT_READ,
  name: 'appointment.booking.create',
  sideEffect: 'write',
  changedDomains: ['appointment'],
  confirm: true,
  requiredScope: 'appointment.booking.create',
} as unknown as CapabilityContract;

const ctx = (): ProjectionContext => ({
  tenantId: 'tnt_test' as ProjectionContext['tenantId'],
  facts: {},
  providerConfig: {},
  idempotencyKeyFor: (capability, input) => `trn_test:${capability}:${JSON.stringify(input)}`,
});

const adapter = (execute: ProviderAdapter['execute']): ProviderAdapter =>
  ({
    providerId: 'internal-scheduler',
    capability: 'appointment.slot.read',
    status: async () => ({
      providerId: 'internal-scheduler',
      health: 'healthy',
      circuit: 'closed',
      lastCheckedAt: '2026-07-16T00:00:00.000Z',
    }),
    execute,
  }) as unknown as ProviderAdapter;

describe('jsonSchemaToZod (bounded allow-list)', () => {
  it('rebuilds an object with required + optional properties', () => {
    const schema = jsonSchemaToZod(SLOT_READ.inputJsonSchema);
    expect(schema.parse({date: '2026-07-20'})).toEqual({date: '2026-07-20'});
    expect(schema.parse({date: '2026-07-20', serviceType: 'panel'})).toEqual({
      date: '2026-07-20',
      serviceType: 'panel',
    });
    expect(() => schema.parse({})).toThrow(); // `date` is required
    expect(() => schema.parse({date: 5})).toThrow();
  });

  it('rebuilds an itemless array as an array of anything', () => {
    const schema = jsonSchemaToZod(SLOT_READ.outputJsonSchema);
    expect(schema.parse({slots: ['a', 'b']})).toEqual({slots: ['a', 'b']});
  });

  // The spec's Open Question: a lossy round-trip must not silently hand the model a WEAKER validator
  // than the authored contract — an unrepresentable construct is a projection-time failure.
  it('THROWS on a keyword outside the allow-list rather than degrading', () => {
    expect(() => jsonSchemaToZod({oneOf: [{type: 'string'}]})).toThrow(UnsupportedSchemaError);
    expect(() => jsonSchemaToZod({type: 'object', properties: {a: {$ref: '#/x'}}})).toThrow(UnsupportedSchemaError);
    expect(() => jsonSchemaToZod({type: 'string', format: 'int64'})).toThrow(UnsupportedSchemaError);
  });

  // Contracts are Zod-first and their JSON Schema is GENERATED from Zod (ADR-020), so the rebuilder
  // must accept exactly what that generator emits — otherwise a spec-faithful contract is skipped and
  // its tool silently vanishes from the agent's tool set.
  it('rebuilds the real Zod→JSON-Schema output ($schema, format+pattern, bounds, default)', () => {
    const generated = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        date: {type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$'},
        email: {type: 'string', format: 'email'},
        n: {type: 'integer', minimum: -10, maximum: 10},
        tz: {default: 'UTC', type: 'string'},
      },
      required: ['date', 'n', 'tz'],
      additionalProperties: false,
    };
    const s = jsonSchemaToZod(generated);
    expect(s.parse({date: '2026-07-20', n: 5})).toEqual({date: '2026-07-20', n: 5, tz: 'UTC'}); // default applied
    expect(() => s.parse({date: 'tomorrow', n: 5})).toThrow(); // format/pattern enforced
    expect(() => s.parse({date: '2026-07-20', n: 99})).toThrow(); // bounds enforced
    expect(() => s.parse({date: '2026-07-20', n: 5, email: 'nope'})).toThrow(); // format enforced
    expect(() => s.parse({date: '2026-07-20', n: 5, sneaky: 1})).toThrow(); // additionalProperties:false REJECTS
  });

  it('honours additionalProperties given as a schema (catchall), not just booleans', () => {
    const s = jsonSchemaToZod({type: 'object', properties: {a: {type: 'string'}}, additionalProperties: {type: 'number'}});
    expect(s.parse({a: 'x', extra: 1})).toEqual({a: 'x', extra: 1});
    expect(() => s.parse({a: 'x', extra: 'not-a-number'})).toThrow();
  });
});

describe('CapabilityToolProjector', () => {
  it('projection is deterministic and pure: same contract → identical options', () => {
    const p = new CapabilityToolProjector(async () => adapter(async () => ({})));
    const a = p.toToolOptions(SLOT_READ);
    const b = p.toToolOptions(SLOT_READ);
    expect(a.scope).toBe(b.scope);
    expect(a.confirm).toBe(b.confirm);
    expect(a.description).toBe(b.description);
  });

  it('scope equals the contract requiredScope (ADR-019 visibility)', () => {
    const p = new CapabilityToolProjector(async () => adapter(async () => ({})));
    expect(p.toToolOptions(SLOT_READ).scope).toBe('appointment.slot.read');
    expect(p.toToolOptions(BOOKING_CREATE).scope).toBe('appointment.booking.create');
  });

  it('registers one tool per pinned capability and indexes its envelope metadata', () => {
    const p = new CapabilityToolProjector(async () => adapter(async () => ({})));
    const {report, bindings, metadata} = p.project([SLOT_READ, BOOKING_CREATE], ctx());

    expect(report.registered.map(r => r.capability)).toEqual([
      'appointment.slot.read',
      'appointment.booking.create',
    ]);
    expect(report.skipped).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(bindings.has('appointment.slot.read')).toBe(true);
    expect(report.registered[0].bindingKey).toBe('platform.capability.tool.appointment.slot.read');

    // Metadata index completeness — get() is never undefined for a projected capability.
    const meta = metadata.get('appointment.slot.read' as CapabilityContract['name']);
    expect(meta).toMatchObject({sideEffect: 'read', changedDomains: ['none'], confirm: false});
  });

  it('confirm tools are projected but excluded from autonomous() (ADR-021)', () => {
    const p = new CapabilityToolProjector(async () => adapter(async () => ({})));
    const {report, metadata} = p.project([SLOT_READ, BOOKING_CREATE], ctx());

    expect(report.registered.find(r => r.capability === 'appointment.booking.create')?.autonomouslyProjectable).toBe(
      false,
    );
    expect(metadata.autonomous()).toEqual(['appointment.slot.read']);
    expect(autonomousProjectionEnabled).toBe(false);
  });

  it('the generic body resolves the ranked provider and returns its UNWRAPPED output', async () => {
    const execute = vi.fn(async () => ({slots: ['2026-07-20T14:00:00-05:00']}));
    const resolve = vi.fn(async () => adapter(execute));
    const p = new CapabilityToolProjector(resolve);
    const {bindings} = p.project([SLOT_READ], ctx());

    const binding = bindings.get('appointment.slot.read')!;
    const Ctor = binding.ctor as new () => Record<string, (i: unknown) => Promise<unknown>>;
    const method = (binding.meta as {methodName: string}).methodName;
    const out = await new Ctor()[method]({date: '2026-07-20'});

    // Unwrapped — NOT a ToolResult envelope (the executor synthesizes that upstream, ADR-018).
    expect(out).toEqual({slots: ['2026-07-20T14:00:00-05:00']});
    expect(resolve).toHaveBeenCalledWith('appointment.slot.read', SLOT_READ.providerMapping, {});
    expect(execute).toHaveBeenCalledWith(
      {date: '2026-07-20'},
      expect.objectContaining({
        tenantId: 'tnt_test',
        capability: 'appointment.slot.read',
        // The key is derived from the INPUT, not the capability alone — two calls with different
        // arguments in one turn must not collide.
        idempotencyKey: 'trn_test:appointment.slot.read:{"date":"2026-07-20"}',
      }),
    );
  });

  it('derives a DISTINCT idempotency key per input within one turn', async () => {
    const keys: string[] = [];
    const p = new CapabilityToolProjector(async () => adapter(async () => ({slots: []})));
    const {bindings} = p.project([SLOT_READ], {
      ...ctx(),
      idempotencyKeyFor: (capability, input) => {
        const k = `trn_test:${capability}:${JSON.stringify(input)}`;
        keys.push(k);
        return k;
      },
    });
    const binding = bindings.get('appointment.slot.read')!;
    const Ctor = binding.ctor as new () => Record<string, (i: unknown) => Promise<unknown>>;
    const method = (binding.meta as {methodName: string}).methodName;

    await new Ctor()[method]({date: '2026-07-20'});
    await new Ctor()[method]({date: '2026-07-21'});

    expect(new Set(keys).size).toBe(2);
  });

  // ToolMetrics.providerId is canonical (agent-runtime-contracts.md; the `internal-scheduler` example
  // in table-catalog.md). The body resolves the provider privately, so it must report it back or the
  // synthesized envelope cannot name who served the call.
  it('reports the resolved providerId so the envelope can carry ToolMetrics.providerId', async () => {
    const served: Array<[string, string]> = [];
    const p = new CapabilityToolProjector(async () => adapter(async () => ({slots: []})));
    const {bindings} = p.project([SLOT_READ], {
      ...ctx(),
      onProviderResolved: (capability, providerId) => served.push([capability, providerId]),
    });

    expect(served).toEqual([]); // nothing resolved until a dispatch actually happens
    const binding = bindings.get('appointment.slot.read')!;
    const Ctor = binding.ctor as new () => Record<string, (i: unknown) => Promise<unknown>>;
    await new Ctor()[(binding.meta as {methodName: string}).methodName]({date: '2026-07-20'});

    expect(served).toEqual([['appointment.slot.read', 'internal-scheduler']]);
  });

  it('skips (never silently degrades) a contract whose schema is outside the allow-list', () => {
    const bad = {...SLOT_READ, inputJsonSchema: {oneOf: [{type: 'string'}]}} as unknown as CapabilityContract;
    const p = new CapabilityToolProjector(async () => adapter(async () => ({})));
    const {report, bindings} = p.project([bad], ctx());

    expect(report.registered).toEqual([]);
    expect(report.skipped[0].capability).toBe('appointment.slot.read');
    expect(bindings.size).toBe(0);
  });

  it('a NoProviderError from resolution propagates (caller maps onNoProvider)', async () => {
    const p = new CapabilityToolProjector(async () => {
      throw new Error('no provider available for appointment.slot.read');
    });
    const {bindings} = p.project([SLOT_READ], ctx());
    const binding = bindings.get('appointment.slot.read')!;
    const Ctor = binding.ctor as new () => Record<string, (i: unknown) => Promise<unknown>>;
    const method = (binding.meta as {methodName: string}).methodName;

    await expect(new Ctor()[method]({date: '2026-07-20'})).rejects.toThrow('no provider available');
  });
});
