// PersistenceComponent (edge): binds the datasources + the Drizzle-backed repository/store ports
// (ADR-022) over ONE shared pool, and registers the lifecycle observers that own connect order,
// the fail-closed RLS boot gate, and reverse-order close.
//
// The Drizzle classes stay free of any @loopback dependency (plane 'none'); this component is the
// place their constructor wiring meets the container — exactly the gap flagged in
// compiled-plan-store.repository.ts ("the @loopback/context binding belongs with the loopback-core
// component wiring").
import {Binding, type Component, type Constructor} from '@loopback/core';
import {inject, BindingScope} from '@loopback/context';
import type {LifeCycleObserver} from '@loopback/core';
import {lifeCycleObserver} from '@loopback/core';
import {
  DrizzleAuditSink,
  DrizzleCompiledPlanStore,
  DrizzleEventOutboxRepository,
  DrizzleHandoffRepository,
  DrizzleMessageRepository,
  DrizzleProviderMappingRepository,
  DrizzleTurnPersistence,
  assertNonBypassingRole,
  createPlatformDb,
  tenantGucPreflight,
  type PlatformDbHandle,
} from '@hermes-one/drizzle';
import {
  DrizzleRoleRegistry,
  DrizzleTenantRepository,
  DrizzleUsageMeter,
  DrizzleUserRepository,
} from '@hermes-one/drizzle';
import {createRedisClient, type RedisClient} from '@hermes-one/redis';
import type {HermesConfig} from '@hermes-one/config';
import {PlatformBindings} from '../bindings.js';
import type {PlatformComponentBoundary} from '../boundary.js';

/** Connects the pool and proves the RLS posture + tenant GUC before anything serves (fail-closed). */
@lifeCycleObserver('datasource')
export class PostgresLifecycleObserver implements LifeCycleObserver {
  constructor(
    @inject(PlatformBindings.POSTGRES)
    private readonly handle: PlatformDbHandle,
  ) {}

  async start(): Promise<void> {
    // Fail-closed boot gate: role posture (NOSUPERUSER/NOBYPASSRLS) + SET LOCAL GUC probe.
    await assertNonBypassingRole(this.handle.db);
    await tenantGucPreflight(this.handle.db);
  }
  async stop(): Promise<void> {
    await this.handle.close();
  }
}

@lifeCycleObserver('datasource')
export class RedisLifecycleObserver implements LifeCycleObserver {
  constructor(
    @inject(PlatformBindings.REDIS) private readonly client: RedisClient,
  ) {}
  async start(): Promise<void> {
    /* ioredis connects lazily on first command; nothing to preflight without a cache read */
  }
  async stop(): Promise<void> {
    await this.client.close();
  }
}

export class PersistenceComponent
  implements Component, PlatformComponentBoundary
{
  readonly plane = 'edge' as const;
  readonly bindsKeys = [
    PlatformBindings.POSTGRES.key,
    PlatformBindings.REDIS.key,
    PlatformBindings.COMPILED_PLAN_STORE.key,
    PlatformBindings.MESSAGE_REPOSITORY.key,
    PlatformBindings.TURN_PERSISTENCE.key,
    PlatformBindings.HANDOFF_REPOSITORY.key,
    PlatformBindings.EVENT_OUTBOX_REPOSITORY.key,
    PlatformBindings.AUDIT_SINK.key,
    PlatformBindings.USAGE_METER.key,
    PlatformBindings.ROLE_REGISTRY.key,
    PlatformBindings.TENANT_REPOSITORY.key,
    PlatformBindings.USER_REPOSITORY.key,
    PlatformBindings.PROVIDER_MAPPING_REPOSITORY.key,
  ];
  readonly implementsExtensionPoints: readonly string[] = [];
  readonly consumesExtensionPoints: readonly string[] = [];
  readonly contributesTags: readonly string[] = [];

  bindings: Binding[] = [
    Binding.bind(PlatformBindings.POSTGRES.key)
      .toDynamicValue(({context}) => {
        const cfg = context.getSync<HermesConfig>(PlatformBindings.CONFIG.key);
        return createPlatformDb(cfg.stores.authoritative.url);
      })
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.REDIS.key)
      .toDynamicValue(({context}) => {
        const cfg = context.getSync<HermesConfig>(PlatformBindings.CONFIG.key);
        return createRedisClient(cfg.stores.ephemeral.url);
      })
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.COMPILED_PLAN_STORE.key)
      .toDynamicValue(
        ({context}) =>
          new DrizzleCompiledPlanStore(
            context.getSync(PlatformBindings.POSTGRES).db,
            context.getSync(PlatformBindings.REDIS),
          ),
      )
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.MESSAGE_REPOSITORY.key)
      .toDynamicValue(
        ({context}) =>
          new DrizzleMessageRepository(
            context.getSync(PlatformBindings.POSTGRES).db,
          ),
      )
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.TURN_PERSISTENCE.key)
      .toDynamicValue(
        ({context}) =>
          new DrizzleTurnPersistence(
            context.getSync(PlatformBindings.POSTGRES).db,
          ),
      )
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.HANDOFF_REPOSITORY.key)
      .toDynamicValue(
        ({context}) =>
          new DrizzleHandoffRepository(
            context.getSync(PlatformBindings.POSTGRES).db,
          ),
      )
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.EVENT_OUTBOX_REPOSITORY.key)
      .toDynamicValue(({context}) => {
        const cfg = context.getSync<HermesConfig>(PlatformBindings.CONFIG.key);
        return new DrizzleEventOutboxRepository(
          context.getSync(PlatformBindings.POSTGRES).db,
          cfg.outbox.maxAttempts,
        );
      })
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.AUDIT_SINK.key)
      .toDynamicValue(
        ({context}) =>
          new DrizzleAuditSink(context.getSync(PlatformBindings.POSTGRES).db),
      )
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.USAGE_METER.key)
      .toDynamicValue(
        ({context}) =>
          new DrizzleUsageMeter(context.getSync(PlatformBindings.POSTGRES).db),
      )
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.ROLE_REGISTRY.key)
      .toDynamicValue(
        ({context}) =>
          new DrizzleRoleRegistry(
            context.getSync(PlatformBindings.POSTGRES).db,
          ),
      )
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.TENANT_REPOSITORY.key)
      .toDynamicValue(
        ({context}) =>
          new DrizzleTenantRepository(
            context.getSync(PlatformBindings.POSTGRES).db,
          ),
      )
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.USER_REPOSITORY.key)
      .toDynamicValue(
        ({context}) =>
          new DrizzleUserRepository(
            context.getSync(PlatformBindings.POSTGRES).db,
          ),
      )
      .inScope(BindingScope.SINGLETON),
    Binding.bind(PlatformBindings.PROVIDER_MAPPING_REPOSITORY.key)
      .toDynamicValue(
        ({context}) =>
          new DrizzleProviderMappingRepository(
            context.getSync(PlatformBindings.POSTGRES).db,
          ),
      )
      .inScope(BindingScope.SINGLETON),
  ];

  lifeCycleObservers: Constructor<LifeCycleObserver>[] = [
    PostgresLifecycleObserver,
    RedisLifecycleObserver,
  ];
}
