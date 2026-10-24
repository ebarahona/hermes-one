// The bridge proof: a PROJECTED capability (built at runtime from a pinned CapabilityContract, with
// the shipped @tool decorator applied programmatically) dispatches through agentback's REAL pipeline
// via `MCPServer.callTool(name, input, {binding})` — authorize → input-validate → invoke →
// output-validate — and reaches the ranked ProviderAdapter.
//
// This is what retires SpikeBookingTools from the live path: before this, the agent plane dispatched
// to hardcoded fixtures with canned data and never touched the provider plane at all.
import {describe, it, expect, vi} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {MCPBindings, type MCPServer} from '@agentback/mcp';
import type {CapabilityContract, ProviderAdapter} from '@hermes-one/contracts';
import {createAgentPlaneApp} from './app.js';
import {
  CapabilityToolProjector,
  type ProjectionContext,
} from './tool-projection.js';

const SLOT_READ = {
  name: 'appointment.slot.read',
  title: 'Read appointment slots',
  description:
    'List open service-visit slots for a given date and service type.',
  inputJsonSchema: {
    type: 'object',
    required: ['date'],
    properties: {date: {type: 'string'}, serviceType: {type: 'string'}},
  },
  outputJsonSchema: {
    type: 'object',
    properties: {slots: {type: 'array'}},
  },
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

const ctx = (): ProjectionContext => ({
  tenantId: 'tnt_elec_demo' as ProjectionContext['tenantId'],
  facts: {},
  providerConfigFor: async () => ({slotTemplates: '14:00:00-05:00'}),
  idempotencyKeyFor: () => 'idem_projected',
});

const schedulerAdapter = (
  execute: ProviderAdapter['execute'],
): ProviderAdapter =>
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

describe('projected capability → real agentback dispatch → provider', () => {
  it('callTool with a projected binding reaches the ranked provider and returns its output', async () => {
    await using t = await createTestApp(() => createAgentPlaneApp());
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);

    const execute = vi.fn(async (input: unknown) => ({
      slots: [`${(input as {date: string}).date}T14:00:00-05:00`],
    }));
    const resolve = vi.fn(async () => schedulerAdapter(execute));
    const {bindings} = new CapabilityToolProjector(resolve).project(
      [SLOT_READ],
      ctx(),
    );

    const output = await server.callTool(
      'appointment.slot.read',
      {date: '2026-07-20'},
      {binding: bindings.get('appointment.slot.read')},
    );

    expect(output).toEqual({slots: ['2026-07-20T14:00:00-05:00']});
    expect(resolve).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("enforces the projected tool's rebuilt Zod input schema (contract is the source of truth)", async () => {
    await using t = await createTestApp(() => createAgentPlaneApp());
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);

    const execute = vi.fn(async () => ({slots: []}));
    const {bindings} = new CapabilityToolProjector(async () =>
      schedulerAdapter(execute),
    ).project([SLOT_READ], ctx());
    const binding = bindings.get('appointment.slot.read');

    // `date` is required by inputJsonSchema → agentback rejects BEFORE the provider is ever resolved.
    await expect(
      server.callTool('appointment.slot.read', {}, {binding}),
    ).rejects.toThrow();
    await expect(
      server.callTool('appointment.slot.read', {date: 42}, {binding}),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  // The live path registers NO fixtures, so a capability that failed to project cannot silently fall
  // through to canned data. Previously, SpikeBookingTools answered 'appointment.slot.read' with
  // a hardcoded fixture on every agent turn.
  it('the live agent-plane app serves no capability without a projected binding', async () => {
    await using t = await createTestApp(() => createAgentPlaneApp());
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);

    expect((await t.mcp.listTools()).tools).toHaveLength(0);
    await expect(
      server.callTool('appointment.slot.read', {date: '2026-07-20'}),
    ).rejects.toThrow(/Unknown tool/);
  });

  it('the fixtures remain available only behind an explicit opt-in (spike specs)', async () => {
    await using t = await createTestApp(() =>
      createAgentPlaneApp({fixtures: true}),
    );
    const names = (await t.mcp.listTools()).tools.map(x => x.name);
    expect(names).toContain('appointment.slot.read');
  });

  it('projects per-turn: two tenants dispatch their OWN contract without collision', async () => {
    await using t = await createTestApp(() => createAgentPlaneApp());
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
    const projector = new CapabilityToolProjector(async () =>
      schedulerAdapter(async () => ({slots: ['tenant-scoped']})),
    );

    const a = projector.project([SLOT_READ], {
      ...ctx(),
      tenantId: 'tnt_a' as ProjectionContext['tenantId'],
    });
    const b = projector.project([SLOT_READ], {
      ...ctx(),
      tenantId: 'tnt_b' as ProjectionContext['tenantId'],
    });

    // Same capability NAME, independent bindings — nothing is registered on the shared app context,
    // so tenant B's projection cannot clobber tenant A's (the multi-tenant reason for per-turn).
    expect(a.bindings.get('appointment.slot.read')).not.toBe(
      b.bindings.get('appointment.slot.read'),
    );
    for (const projected of [a, b]) {
      const out = await server.callTool(
        'appointment.slot.read',
        {date: '2026-07-20'},
        {binding: projected.bindings.get('appointment.slot.read')},
      );
      expect(out).toEqual({slots: ['tenant-scoped']});
    }
  });
});
