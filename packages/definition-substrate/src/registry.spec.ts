import {describe, expect, it} from 'vitest';
import {
  PlatformErrorException,
  type Definition,
  type PrincipalId,
  type SemVer,
  type ValidatedContractBase,
} from '@hermes-one/contracts';
import {DefinitionRegistry} from './registry.js';
import type {DefinitionWritePort, PlanStorePort} from './ports.js';

const ACTOR = 'prn_spec' as PrincipalId;
const AT = '2026-07-20T00:00:00.000Z';

// A valid capability body (mirrors apps/admin-api definition-route.itest.ts / publish.ts).
const capabilityBody = {
  name: 'appointment.slot.read',
  title: 'Read appointment slots',
  description: 'List open appointment slots for a given date.',
  inputJsonSchema: {
    type: 'object',
    required: ['date'],
    properties: {date: {type: 'string'}},
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
};

// A valid agent-engine body (mirrors apps/workflow-worker publish.ts).
const agentEngineBody = {
  persona: 'A concise scheduling assistant.',
  objectives: ['help the customer reschedule'],
  allowedCapabilities: ['appointment.slot.read'],
  referencedRules: [],
  model: {provider: 'local', model: 'x', temperature: 0},
  promptTemplateIds: [],
};

const authored = (
  id: string,
  kind: Definition['kind'],
  name: string,
  body: unknown,
  over: Record<string, unknown> = {},
): Definition =>
  ({
    definitionId: id,
    tenantId: 'tnt_spec',
    kind,
    name,
    schemaRef: `${name}.${kind}/v1`,
    version: '1.0.0',
    status: 'draft',
    labels: {},
    createdAt: AT,
    updatedAt: AT,
    createdBy: ACTOR,
    body,
    ...over,
  }) as unknown as Definition;

function fakes() {
  const stored: ValidatedContractBase[] = [];
  const store = {
    putCompiledPlan: async () => ({planId: 'pln_x', deduped: false}),
    putValidatedContract: async (contract: ValidatedContractBase) => {
      stored.push(contract);
      return {deduped: false};
    },
  } as unknown as PlanStorePort;
  const definitions = {
    putDefinition: async () => ({versionInserted: true}),
    getDefinition: async () => null,
  } as unknown as DefinitionWritePort;
  const registry = new DefinitionRegistry({
    store,
    definitions,
    compilers: {},
    compilerVersion: '1.0.0' as SemVer,
    now: () => AT,
  });
  return {registry, stored};
}

describe('DefinitionRegistry.put — contract-schema validation', () => {
  it('publishes a valid capability body (planId null, ValidatedContractBase stored)', async () => {
    const {registry, stored} = fakes();
    const res = await registry.put(
      authored(
        'def_cap_ok',
        'capability',
        'appointment-slot-read',
        capabilityBody,
      ),
      ACTOR,
    );
    expect(res.status).toBe('published');
    expect(res.planId).toBeNull();
    expect(res.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stored).toHaveLength(1);
    expect(stored[0].kind).toBe('capability');
    expect(stored[0].contentHash).toBe(res.contentHash);
  });

  it('rejects a garbage capability body with the typed 422 validation error, storing nothing', async () => {
    const {registry, stored} = fakes();
    const attempt = registry.put(
      authored('def_cap_bad', 'capability', 'appointment-slot-read', {
        name: 'x',
      }),
      ACTOR,
    );
    await expect(attempt).rejects.toThrow(PlatformErrorException);
    await expect(attempt).rejects.toMatchObject({
      error: {
        category: 'validation',
        code: 'validation_failed',
        httpStatus: 422,
      },
    });
    expect(stored).toHaveLength(0);
  });

  it('publishes a valid agent-engine body and rejects a garbage one', async () => {
    const {registry, stored} = fakes();
    const ok = await registry.put(
      authored('def_eng_ok', 'agent-engine', 'assistant', agentEngineBody),
      ACTOR,
    );
    expect(ok.status).toBe('published');
    expect(ok.planId).toBeNull();
    expect(stored[0].kind).toBe('agent-engine');
    await expect(
      registry.put(
        authored('def_eng_bad', 'agent-engine', 'assistant', {persona: ''}),
        ACTOR,
      ),
    ).rejects.toMatchObject({
      error: {code: 'validation_failed', httpStatus: 422},
    });
  });

  it('is idempotent — re-putting an identical capability body yields the same contentHash', async () => {
    const {registry} = fakes();
    const a = await registry.put(
      authored(
        'def_cap_ok',
        'capability',
        'appointment-slot-read',
        capabilityBody,
      ),
      ACTOR,
    );
    const b = await registry.put(
      authored(
        'def_cap_ok',
        'capability',
        'appointment-slot-read',
        capabilityBody,
      ),
      ACTOR,
    );
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.status).toBe('published');
  });

  it('asserts the SchemaRef grammar `<name>.<type>/vN` at put', async () => {
    const {registry} = fakes();
    await expect(
      registry.put(
        authored('def_cap_ref', 'capability', 'slot-read', capabilityBody, {
          schemaRef: 'slot-read.capability',
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({
      error: {code: 'validation_failed', httpStatus: 422},
    });
    await expect(
      registry.put(
        authored('def_cap_ref', 'capability', 'slot-read', capabilityBody, {
          schemaRef: 'slot-read.foo/v1',
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({
      error: {code: 'validation_failed', httpStatus: 422},
    });
  });
});
