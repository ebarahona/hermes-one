// node-postgres connection factories for the authoritative store (ADR-022). The request-time handle
// adopts the non-bypassable platform_app role on every physical connection; the migrator handle keeps
// the privileged login for DDL. RLS on platform_app is the real tenant boundary.
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {createRedisClient, type RedisClient} from '@platform-internal/redis';
import type {PlatformDb} from './tenant-aware.repository.js';
import {DrizzleMessageRepository} from './message-repository.js';
import {DrizzleTurnLedgerRepository} from './turn-ledger-repository.js';
import {DrizzleHandoffRepository} from './handoff-repository.js';
import {DrizzleAuditSink} from './audit-repository.js';
import {DrizzleUsageMeter} from './usage-repository.js';
import {DrizzleAuditQueryService} from './audit-query.js';
import {DrizzleTurnPersistence} from './turn-persistence.js';
import {DrizzleEventOutboxRepository} from './event-outbox-repository.js';
import {DrizzleRoleRegistry} from './role-registry.js';
import {DrizzleCredentialRowStore} from './provider-credential-rows.js';
import {DrizzleVerticalPackInstallationRepository} from './vertical-pack-repository.js';
import {DrizzleProviderMappingRepository} from './provider-mapping-repository.js';
import {assertNonBypassingRole} from './rls-self-check.js';
import {
  DrizzleDefinitionRepository,
  DrizzleDeploymentRepository,
} from './substrate-repository.js';
import {
  DrizzleCompiledPlanStore,
  DEFAULT_SUBSTRATE_CACHE,
  type SubstrateCacheConfig,
} from './adapters/compiled-plan-store.repository.js';

const ROLE_RE = /^[a-z_][a-z0-9_]*$/;

export interface PlatformDbHandle {
  db: PlatformDb;
  pool: Pool;
  close(): Promise<void>;
}

/**
 * The request-time handle. `appRole` (default `platform_app`) is adopted at connection start via the
 * PG `options=-c role=…` startup parameter (race-free — applied before any query runs), so even a login
 * that is the owner/superuser executes under the non-bypassable role RLS depends on. In production the
 * login IS platform_app and the role option is a harmless no-op. Validated against ROLE_RE (the value
 * is embedded in the startup string, so it can't be parameterized).
 */
export function createPlatformDb(url: string, opts: {appRole?: string} = {}): PlatformDbHandle {
  const appRole = opts.appRole ?? 'platform_app';
  if (!ROLE_RE.test(appRole)) throw new Error(`invalid appRole: ${appRole}`);
  const pool = new Pool({connectionString: url, options: `-c role=${appRole}`});
  return {db: drizzle(pool), pool, close: () => pool.end()};
}

/** Privileged handle for migrations only (no SET ROLE) — never bound at request time. */
export function createMigratorDb(url: string): PlatformDbHandle {
  const pool = new Pool({connectionString: url});
  return {db: drizzle(pool), pool, close: () => pool.end()};
}

/**
 * The persistence-boot RLS self-check (row-level-security.md: "run once at persistence boot; boot
 * aborts otherwise"). Call from EVERY composition root that opens a request-time pool — a
 * misconfigured production login (superuser / BYPASSRLS) fails startup instead of silently running
 * with RLS as a no-op.
 */
export async function assertRlsPostureAtBoot(pgUrl: string, opts: {appRole?: string} = {}): Promise<void> {
  const handle = createPlatformDb(pgUrl, opts);
  try {
    await assertNonBypassingRole(handle.db);
  } finally {
    await handle.close();
  }
}

export interface CompiledPlanStoreHandle {
  store: DrizzleCompiledPlanStore;
  close(): Promise<void>;
}

export interface MessageRepositoryHandle {
  repo: DrizzleMessageRepository;
  close(): Promise<void>;
}

/** Convenience composition: pg (as platform_app) → a tenant-scoped message repository. */
export function createMessageRepository(
  pgUrl: string,
  opts: {appRole?: string} = {},
): MessageRepositoryHandle {
  const {db, pool} = createPlatformDb(pgUrl, {appRole: opts.appRole});
  return {repo: new DrizzleMessageRepository(db), close: () => pool.end()};
}

export interface TurnLedgerRepositoryHandle {
  repo: DrizzleTurnLedgerRepository;
  close(): Promise<void>;
}

/** Convenience composition: pg (as platform_app) → a tenant-scoped turn-ledger repository. */
export function createTurnLedgerRepository(
  pgUrl: string,
  opts: {appRole?: string} = {},
): TurnLedgerRepositoryHandle {
  const {db, pool} = createPlatformDb(pgUrl, {appRole: opts.appRole});
  return {repo: new DrizzleTurnLedgerRepository(db), close: () => pool.end()};
}

export interface HandoffRepositoryHandle {
  repo: DrizzleHandoffRepository;
  close(): Promise<void>;
}

/** Convenience composition: pg (as platform_app) → a tenant-scoped handoff repository. */
export function createHandoffRepository(
  pgUrl: string,
  opts: {appRole?: string} = {},
): HandoffRepositoryHandle {
  const {db, pool} = createPlatformDb(pgUrl, {appRole: opts.appRole});
  return {repo: new DrizzleHandoffRepository(db), close: () => pool.end()};
}

export interface AuditSinkHandle {
  repo: DrizzleAuditSink;
  close(): Promise<void>;
}

/** Convenience composition: pg (as platform_app) → a tenant-scoped append-only audit sink. */
export function createAuditSink(pgUrl: string, opts: {appRole?: string} = {}): AuditSinkHandle {
  const {db, pool} = createPlatformDb(pgUrl, {appRole: opts.appRole});
  return {repo: new DrizzleAuditSink(db), close: () => pool.end()};
}

export interface UsageMeterHandle {
  repo: DrizzleUsageMeter;
  close(): Promise<void>;
}

/** Convenience composition: pg (as platform_app) → a tenant-scoped usage meter. */
export function createUsageMeter(pgUrl: string, opts: {appRole?: string} = {}): UsageMeterHandle {
  const {db, pool} = createPlatformDb(pgUrl, {appRole: opts.appRole});
  return {repo: new DrizzleUsageMeter(db), close: () => pool.end()};
}

export interface TurnPersistenceHandle {
  repo: DrizzleTurnPersistence;
  close(): Promise<void>;
}

/** Convenience composition: pg (as platform_app) → the ATOMIC turn-persistence writer (F3). */
export function createTurnPersistence(pgUrl: string, opts: {appRole?: string} = {}): TurnPersistenceHandle {
  const {db, pool} = createPlatformDb(pgUrl, {appRole: opts.appRole});
  return {repo: new DrizzleTurnPersistence(db), close: () => pool.end()};
}

export interface EventOutboxRepositoryHandle {
  repo: DrizzleEventOutboxRepository;
  close(): Promise<void>;
}

/** Convenience composition: pg (as platform_app) → the transactional-outbox repository. */
export function createEventOutboxRepository(
  pgUrl: string,
  opts: {appRole?: string; maxAttempts?: number} = {},
): EventOutboxRepositoryHandle {
  const {db, pool} = createPlatformDb(pgUrl, {appRole: opts.appRole});
  return {repo: new DrizzleEventOutboxRepository(db, opts.maxAttempts), close: () => pool.end()};
}

export interface RoleRegistryHandle {
  repo: DrizzleRoleRegistry;
  close(): Promise<void>;
}

/** Convenience composition: pg (as platform_app) → the role→scope registry (role-matrix.md). */
export function createRoleRegistry(pgUrl: string, opts: {appRole?: string} = {}): RoleRegistryHandle {
  const {db, pool} = createPlatformDb(pgUrl, {appRole: opts.appRole});
  return {repo: new DrizzleRoleRegistry(db), close: () => pool.end()};
}

export interface CredentialRowStoreHandle {
  repo: DrizzleCredentialRowStore;
  close: () => Promise<void>;
}

/** Row store behind @platform-internal/secrets' EnvelopeCredentialStore (ADR-026, migration 0030). */
export interface VerticalPackInstallationsHandle {
  repo: DrizzleVerticalPackInstallationRepository;
  close: () => Promise<void>;
}

/** tenant.vertical_pack_installations (ADR-013/CT2) — written by the vertical installer. */
export function createVerticalPackInstallations(pgUrl: string, opts: {appRole?: string} = {}): VerticalPackInstallationsHandle {
  const {db, pool} = createPlatformDb(pgUrl, {appRole: opts.appRole});
  return {repo: new DrizzleVerticalPackInstallationRepository(db), close: () => pool.end()};
}

export function createCredentialRowStore(pgUrl: string, opts: {appRole?: string} = {}): CredentialRowStoreHandle {
  const {db, pool} = createPlatformDb(pgUrl, {appRole: opts.appRole});
  return {repo: new DrizzleCredentialRowStore(db), close: () => pool.end()};
}

export interface ProviderMappingRepositoryHandle {
  repo: DrizzleProviderMappingRepository;
  close: () => Promise<void>;
}

/** Convenience composition: pg (as platform_app) → the tenant provider-mapping override repository
 *  (capability.provider_mappings, migration 0023/0024, RLS strict). */
export function createProviderMappingRepository(
  pgUrl: string,
  opts: {appRole?: string} = {},
): ProviderMappingRepositoryHandle {
  const {db, pool} = createPlatformDb(pgUrl, {appRole: opts.appRole});
  return {repo: new DrizzleProviderMappingRepository(db), close: () => pool.end()};
}

export interface AuditQueryServiceHandle {
  repo: DrizzleAuditQueryService;
  close(): Promise<void>;
}

/** Convenience composition: pg (as platform_app) → the read-side audit timeline/query service. */
export function createAuditQueryService(pgUrl: string, opts: {appRole?: string} = {}): AuditQueryServiceHandle {
  const {db, pool} = createPlatformDb(pgUrl, {appRole: opts.appRole});
  return {repo: new DrizzleAuditQueryService(db), close: () => pool.end()};
}

export interface SubstrateWriteHandle {
  definitions: DrizzleDefinitionRepository;
  deployments: DrizzleDeploymentRepository;
  close(): Promise<void>;
}

/** Convenience composition: pg (as platform_app) → the tenant-scoped substrate write repositories. */
export function createSubstrateWrite(pgUrl: string, opts: {appRole?: string} = {}): SubstrateWriteHandle {
  const {db, pool} = createPlatformDb(pgUrl, {appRole: opts.appRole});
  return {
    definitions: new DrizzleDefinitionRepository(db),
    deployments: new DrizzleDeploymentRepository(db),
    close: () => pool.end(),
  };
}

/** Convenience composition: pg (as platform_app) + Redis → a wired CompiledPlanStore. */
export function createCompiledPlanStore(
  pgUrl: string,
  redisUrl: string,
  opts: {appRole?: string; cache?: SubstrateCacheConfig} = {},
): CompiledPlanStoreHandle {
  const {db, pool} = createPlatformDb(pgUrl, {appRole: opts.appRole});
  const redis: RedisClient = createRedisClient(redisUrl);
  const store = new DrizzleCompiledPlanStore(db, redis, opts.cache ?? DEFAULT_SUBSTRATE_CACHE);
  return {
    store,
    close: async () => {
      await pool.end();
      await redis.close();
    },
  };
}
