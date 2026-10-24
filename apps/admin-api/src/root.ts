// AdminApiRoot — the admin-api composition root (the CompositionRoot
// contract). Builds a PlatformRestApplication, mounts the platform REST sequence (correlation +
// fail-closed authentication + the single PlatformError exit) and the controllers, then serves by
// LB4 HTTP listen. Driven by the shared bootstrap() (main.ts) or, in the e2e, by calling the phases
// directly against an ephemeral port.
//
// Persistence (on by default) registers the shared PG pool and the fail-closed RLS boot gate, which
// runs at start() before the REST server listens. AUTH-3: the AuthComponent binds the strategy registry + principal
// mapper + api-key strategy; the root supplies the request-shaped bits (the AuthConfig + the
// config/seed-backed ApiKeyStore) — the same split as the ChannelComponent + credential store.
import type {HermesConfig} from '@hermes-one/config';
import {
  PersistenceComponent,
  PlatformBindings,
  PlatformRestApplication,
  registerPlatformRestSequence,
  SubstrateComponent,
} from '@hermes-one/loopback-core';
import {
  AuthBindings,
  AuthComponent,
  AuthConfig,
  StaticApiKeyStore,
  type ApiKeySeed,
} from '@hermes-one/auth';
import type {CompositionRoot, JwtVerifier} from '@hermes-one/contracts';
import {PingController} from './ping.controller.js';
import {WhoamiController} from './whoami.controller.js';
import {RoleController} from './role.controller.js';
import {DeploymentController} from './deployment.controller.js';
import {TenantController} from './tenant.controller.js';
import {DefinitionController} from './definition.controller.js';
import {UserController} from './user.controller.js';
import {ProviderMappingController} from './provider-mapping.controller.js';

export interface AdminApiRootOptions {
  /** Dev/seed api keys for the StaticApiKeyStore. Empty in prod until the DB-backed store lands. */
  readonly apiKeySeeds?: readonly ApiKeySeed[];
  /** Register the Persistence component (shared PG pool + RLS boot gate + ROLE_REGISTRY). Default true.
   *  The hermetic sequence/auth spec sets false so it boots with no backing stack. */
  readonly withPersistence?: boolean;
  /** Full auth config (apiKey + optional oidc). Defaults to api-key-only ({apiKey:{}}). */
  readonly authConfig?: AuthConfig;
  /** The OIDC JwtVerifier (JWKS-backed). When present, the oidc strategy activates (bearer JWTs). */
  readonly jwtVerifier?: JwtVerifier;
}

export class AdminApiRoot implements CompositionRoot<PlatformRestApplication> {
  private readonly apiKeySeeds: readonly ApiKeySeed[];
  private readonly withPersistence: boolean;
  private readonly authConfig: AuthConfig;
  private readonly jwtVerifier?: JwtVerifier;

  constructor(
    private readonly config: HermesConfig,
    opts: AdminApiRootOptions = {},
  ) {
    this.apiKeySeeds = opts.apiKeySeeds ?? [];
    this.withPersistence = opts.withPersistence ?? true;
    this.authConfig = opts.authConfig ?? AuthConfig.parse({apiKey: {}});
    this.jwtVerifier = opts.jwtVerifier;
  }

  createApp(): PlatformRestApplication {
    return new PlatformRestApplication({
      rest: {host: '127.0.0.1', port: this.config.api.port},
    });
  }

  bindPorts(app: PlatformRestApplication): void {
    app.bind(PlatformBindings.CONFIG.key).to(this.config);
    // AUTH-3 config + stores (request-shaped bits the AuthComponent can't supply).
    app.bind(AuthBindings.CONFIG.key).to(this.authConfig);
    app
      .bind(AuthBindings.API_KEY_STORE.key)
      .to(new StaticApiKeyStore(this.apiKeySeeds));
    // The oidc strategy stays inert unless a verifier is bound (docs/design/001-edge-authn-design.md).
    if (this.jwtVerifier)
      app.bind(AuthBindings.JWT_VERIFIER.key).to(this.jwtVerifier);
  }

  registerComponents(app: PlatformRestApplication): void {
    registerPlatformRestSequence(app);
    app.component(AuthComponent);
    // Persistence: the shared PG pool, ROLE_REGISTRY, and the fail-closed RLS boot gate (observers run
    // at app.start(), datasource-before-server, so the gate fires before the REST server listens).
    if (this.withPersistence) {
      app.component(PersistenceComponent);
      app.component(SubstrateComponent); // DEPLOYMENT_SERVICE (reads over the bound store)
    }
    app.controller(PingController);
    app.controller(WhoamiController);
    app.controller(RoleController);
    app.controller(DeploymentController);
    app.controller(TenantController);
    app.controller(DefinitionController);
    app.controller(UserController);
    app.controller(ProviderMappingController);
  }

  async start(_app: PlatformRestApplication): Promise<void> {
    // Pools/datasources open via the Persistence lifecycle observers in app.start() (serve), which runs
    // the fail-closed RLS gate before the REST server accepts traffic.
  }

  async serve(app: PlatformRestApplication, stop: AbortSignal): Promise<void> {
    await app.start(); // LB4 lifecycle: RLS boot gate (datasource observers) → RestServer listens.
    if (stop.aborted) return;
    await new Promise<void>(resolve => {
      stop.addEventListener('abort', () => resolve(), {once: true});
    });
  }

  async stop(app: PlatformRestApplication): Promise<void> {
    await app.stop();
  }
}
