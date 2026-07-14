// T1 — the real agentback substrate works under our Vitest-on-src setup:
// a @tool with Zod input/output registers and dispatches via the in-process
// `MCPServer.callTool` seam, returning the UNWRAPPED, output-validated result
// (the seam the platform ToolExecutor wraps, ADR-018). Mirrors the agentback
// consumer demo's createTestApp harness.
import {describe, it, expect} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {MCPBindings, type MCPServer} from '@agentback/mcp';
import {createAgentPlaneApp} from './app.js';
import {SlotReadOutput} from './spike-tools.js';

describe('T1 — agentback @tool dispatch via callTool', () => {
  it('registers both the read-only and the confirm: tool', async () => {
    await using t = await createTestApp(() => createAgentPlaneApp());
    const names = (await t.mcp.listTools()).tools.map(x => x.name).sort();
    expect(names).toContain('appointment.slot.read');
    expect(names).toContain('appointment.booking.create');
  });

  it("dispatches the read tool and returns agentback's unwrapped, output-validated result", async () => {
    await using t = await createTestApp(() => createAgentPlaneApp());
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);

    const output = await server.callTool('appointment.slot.read', {
      date: '2026-07-12',
    });

    // callTool returns the bare method result (NOT an MCP CallToolResult
    // envelope) — already validated against the tool's `output:` schema.
    const parsed = SlotReadOutput.parse(output);
    expect(parsed.slots).toHaveLength(2);
    expect(parsed.slots[0]).toContain('2026-07-12');
  });

  it("rejects input that violates the tool's Zod input schema", async () => {
    await using t = await createTestApp(() => createAgentPlaneApp());
    const server = await t.app.get<MCPServer>(MCPBindings.SERVER);
    await expect(
      // date must be a string
      server.callTool('appointment.slot.read', {
        date: 123 as unknown as string,
      }),
    ).rejects.toThrow();
  });
});
