// The single tenant-scoped execution primitive every Drizzle adapter uses. Opens a transaction,
// pins the tenant GUC via a parameterized set_config(..., is_local=true) (== SET LOCAL, safe under
// pgbouncer transaction pooling), and runs the callback inside it. Fail-closed on a blank tenant:
// no SQL is issued. RLS on a NOSUPERUSER/NOBYPASSRLS role is the real boundary (ADR-022).
import {sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {PlatformErrorException} from '@platform/contracts';
import type {TenantScope} from '@platform/contracts';

/** The Drizzle db handle bound at `platform.data.postgres`. */
export type PlatformDb = NodePgDatabase<Record<string, never>>;

/** A transaction-bound Drizzle handle passed into `withTenant`'s callback. */
export type PlatformTx = Parameters<
  Parameters<PlatformDb['transaction']>[0]
>[0];

/**
 * Base for every Drizzle repository adapter. Stateless singleton (no identity map, no tenant field).
 * The ONLY way to touch tenant-owned tables — it guarantees the SET LOCAL and fail-closed behavior.
 */
export abstract class TenantAwareRepository {
  constructor(protected readonly db: PlatformDb) {}

  /**
   * Open a transaction, pin the tenant GUC, run `fn` inside it.
   * - Fails CLOSED if tenantId is missing/blank (no SQL is issued).
   * - `SET LOCAL` is transaction-scoped, so it is safe under pgbouncer transaction pooling.
   * - RLS reads `current_setting('app.tenant_id')` on the same connection/txn.
   */
  protected async withTenant<T>(
    scope: TenantScope,
    fn: (tx: PlatformTx) => Promise<T>,
  ): Promise<T> {
    const tenantId = scope?.tenantId?.trim();
    if (!tenantId) {
      throw new PlatformErrorException({
        category: 'authorization',
        code: 'tenant_not_resolved',
        message: 'Repository call without a resolved tenantId (fail-closed).',
        issues: [],
        retryable: false,
        httpStatus: 403,
      });
    }
    return this.db.transaction(async tx => {
      // Parameterized to avoid injection; set_config(local=true) === SET LOCAL.
      await tx.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true)`,
      );
      return fn(tx);
    });
  }
}
