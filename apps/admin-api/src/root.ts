// AdminApiRoot — the admin-api composition root (loopback/application-bootstrap.md, the CompositionRoot
// contract). Builds a PlatformRestApplication, mounts the platform REST sequence (correlation +
// fail-closed authentication + the single PlatformError exit) and the controllers, then serves by
// LB4 HTTP listen. Driven by the shared bootstrap() (main.ts) or, in the e2e, by calling the phases
// directly against an ephemeral port.
//
// Slice 1/2 scope: no datasource is bound, so start() has no pool to open and the app is exempt from
// the ADR-022 fail-closed tenant gate (application-bootstrap.md: "workflow-worker (no repositories) …
// are exempt"). The RLS boot gate + tenant-tx interceptor land with the first repository-backed
// controller (Slice 3). AUTH-3 (Slice 2): the AuthComponent binds the strategy registry + principal
// mapper + api-key strategy; the root supplies the request-shaped bits (the AuthConfig + the
// config/seed-backed ApiKeyStore) — the same split as the ChannelComponent + credential store.
import type {HermesConfig} from '@platform-internal/config';
import {
  PlatformBindings,
  PlatformRestApplication,
  registerPlatformRestSequence,
} from '@platform-internal/loopback-core';
import {
  AuthBindings,
  AuthComponent,
  AuthConfig,
  StaticApiKeyStore,
  type ApiKeySeed,
} from '@platform-internal/auth';
import type {CompositionRoot} from '@platform/contracts';
import {PingController} from './ping.controller.js';
import {WhoamiController} from './whoami.controller.js';

export class AdminApiRoot implements CompositionRoot<PlatformRestApplication> {
  constructor(
    private readonly config: HermesConfig,
    /** Dev/seed api keys for the StaticApiKeyStore. Empty in prod until the DB-backed store lands. */
    private readonly apiKeySeeds: readonly ApiKeySeed[] = [],
  ) {}

  createApp(): PlatformRestApplication {
    return new PlatformRestApplication({
      rest: {host: '127.0.0.1', port: this.config.api.port},
    });
  }

  bindPorts(app: PlatformRestApplication): void {
    app.bind(PlatformBindings.CONFIG.key).to(this.config);
    // AUTH-3 config + store (request-shaped bits the AuthComponent can't supply).
    app.bind(AuthBindings.CONFIG.key).to(AuthConfig.parse({apiKey: {}}));
    app.bind(AuthBindings.API_KEY_STORE.key).to(new StaticApiKeyStore(this.apiKeySeeds));
  }

  registerComponents(app: PlatformRestApplication): void {
    registerPlatformRestSequence(app);
    app.component(AuthComponent);
    app.controller(PingController);
    app.controller(WhoamiController);
  }

  async start(_app: PlatformRestApplication): Promise<void> {
    // No pools/datasources in Slice 1 — nothing to open before serving.
  }

  async serve(app: PlatformRestApplication, stop: AbortSignal): Promise<void> {
    await app.start(); // LB4 lifecycle: the RestServer begins listening.
    if (stop.aborted) return;
    await new Promise<void>(resolve => {
      stop.addEventListener('abort', () => resolve(), {once: true});
    });
  }

  async stop(app: PlatformRestApplication): Promise<void> {
    await app.stop();
  }
}
