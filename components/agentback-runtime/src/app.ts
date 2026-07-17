// Agent-plane Application (ADR-017): the single @agentback container that hosts
// tool contracts + dispatch. The platform owns the loop (ADR-021); this module
// only stands up the agentback substrate and registers tool providers.
import {MCPApplication, MCPBindings} from '@agentback/mcp';
import {SpikeBookingTools} from './spike-tools.js';

export interface AgentPlaneAppOptions {
  /**
   * Register the SpikeBookingTools de-risking FIXTURES (canned data). OFF by default: the live turn
   * projects its pinned CapabilityContracts into provider-backed tools (CapabilityToolProjector,
   * tool-projection.md), so a statically-registered fixture answering to the same capability name
   * could serve canned data as if it were provider evidence. Only the spike specs that validate the
   * agentback substrate itself (T1–T5) turn this on.
   */
  fixtures?: boolean;
}

/**
 * Build the agent-plane app. stdio is disabled so in-process dispatch (`callTool`) never hijacks
 * stdout — configured before `start()` so the MCPServer picks it up.
 */
export function createAgentPlaneApp(opts: AgentPlaneAppOptions = {}): MCPApplication {
  const app = new MCPApplication();
  app.configure(MCPBindings.SERVER).to({transports: {stdio: false}});
  if (opts.fixtures) app.service(SpikeBookingTools);
  return app;
}
