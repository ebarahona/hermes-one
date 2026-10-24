// The single-step model seam (ADR-021). NOTE: the agent turn contract names the model
// substrate but leaves the port out of scope (wired in agentback/).
// This port is authored to ADR-021's single-step contract and kept in the infrastructure layer;
// the agent loop depends only on this interface, never on a vendor SDK.
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/** A tool exposed to the model (provider-legal name + JSON Schema parameters). */
export interface ModelToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Token/cost accounting for one single-step call — feeds TurnResult.metrics. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** One single-step model proposal: free-text and/or tool calls. */
export interface ModelResult {
  text: string;
  toolCalls: Array<{name: string; arguments: Record<string, unknown>}>;
  usage: ModelUsage;
}

export interface ModelCompleteRequest {
  messages: ModelMessage[];
  tools?: ModelToolSpec[];
  /** Model id for this call (the agent engine's model); absent or empty → the adapter's configured default. */
  model?: string;
  /** Sampling temperature for this call; absent → the adapter's default (0). */
  temperature?: number;
}

/** The platform-owned loop calls this once per step (propose). Never an autonomous agent loop. */
export interface SingleStepModel {
  complete(req: ModelCompleteRequest): Promise<ModelResult>;
}
