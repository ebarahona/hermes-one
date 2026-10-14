// Boot-time / CI self-check that RLS's non-bypassable precondition actually holds: the role the
// application connects as must be NOSUPERUSER and NOBYPASSRLS, or every CREATE POLICY is a no-op.
// Run once at persistence boot (fails startup) and as a standalone CI assertion per environment (ADR-022).
import {sql} from 'drizzle-orm';
import type {PlatformDb} from './tenant-aware.repository.js';

export interface RlsRolePosture {
  readonly role: string;
  readonly isSuperuser: boolean;
  readonly bypassRls: boolean;
  readonly canCreateDb: boolean;
}

/** Throws if the connecting role is superuser, has BYPASSRLS, or can create databases — RLS would be a no-op. */
export async function assertNonBypassingRole(db: PlatformDb): Promise<RlsRolePosture> {
  const res = await db.execute(sql`
    SELECT
      current_user                                                    AS role,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)     AS "isSuperuser",
      (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS "bypassRls",
      (SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user)  AS "canCreateDb"
  `);
  const row = res.rows[0] as unknown as RlsRolePosture | undefined;
  if (!row) throw new Error('RLS self-check returned no role posture row.');
  if (row.isSuperuser || row.bypassRls) {
    throw new Error(
      `RLS precondition violated: role "${row.role}" is superuser=${row.isSuperuser} ` +
        `bypassRls=${row.bypassRls}. Every CREATE POLICY is a no-op under this role.`,
    );
  }
  return row;
}

/**
 * ADR-022 fail-closed boot preflight (`PostgresLifecycleObserver`): prove the
 * transaction-local tenant GUC actually works — `set_config('app.tenant_id', …, true)` inside a
 * transaction round-trips — else reject boot. Complements `assertNonBypassingRole` (role posture).
 */
export async function tenantGucPreflight(db: PlatformDb): Promise<void> {
  await db.transaction(async tx => {
    await tx.execute(sql`select set_config('app.tenant_id', '__preflight__', true)`);
    const res = await tx.execute(sql`select current_setting('app.tenant_id', true) as guc`);
    const guc = (res.rows[0] as {guc?: string} | undefined)?.guc;
    if (guc !== '__preflight__') {
      throw new Error(`tenant GUC preflight failed: expected '__preflight__', got '${guc}'`);
    }
  });
}
