// @hermes-one/contracts — src/composition-root.ts
// The per-process composition-root contract (this repo keeps contracts flat). Pure TS: no @loopback dependency;
// the TApp type parameter is the plane's container (edge @loopback Application OR agent @agentback Application), so the contract
// itself stays plane-neutral (ADR-017).

/** Extends the 002 contract with serve(); binding key: none (constructed, not injected). */
export interface CompositionRoot<TApp> {
  /** Construct the plane's Application/Context (edge @loopback OR agent @agentback). */
  createApp(): TApp;
  /** Bind every port the hosted components require to a concrete infrastructure adapter. */
  bindPorts(app: TApp): void;
  /** component()/createBindingFromClass; register lifecycle observers. */
  registerComponents(app: TApp): void;
  /** Start pools/servers via lifecycle observers. MUST reject (fail-closed) if tenant
   *  scoping cannot be enforced (ADR-022) or a required pool preflight fails. */
  start(app: TApp): Promise<void>;
  /** Begin serving: HTTP listen (api-gateway/admin-api) OR Temporal worker.runUntil(signal). */
  serve(app: TApp, stop: AbortSignal): Promise<void>;
  /** Reverse-order observer stop, in-flight drain, pool close. Idempotent. */
  stop(app: TApp): Promise<void>;
}
