// Agent-plane Application (ADR-017): the single @agentback container that hosts
// tool contracts + dispatch. The platform owns the loop (ADR-021); this module
// only stands up the agentback substrate and registers tool providers.
import {MCPApplication, MCPBindings} from '@agentback/mcp';
import {SpikeBookingTools} from './spike-tools.js';

/**
 * Build the agent-plane app with the spike tool providers registered. stdio is
 * disabled so in-process dispatch (`callTool`) never hijacks stdout — configured
 * before `start()` so the MCPServer picks it up.
 */
export function createAgentPlaneApp(): MCPApplication {
  const app = new MCPApplication();
  app.configure(MCPBindings.SERVER).to({transports: {stdio: false}});
  app.service(SpikeBookingTools);
  return app;
}
