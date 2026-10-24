// @hermes-one/contracts — src/tenant-scope.ts
// The mandatory tenant selector every repository method takes, plus the
// optimistic-concurrency token. Fail-closed tenant scoping.
import type {TenantId} from './substrate.js';

/**
 * The mandatory tenant selector every repository method takes.
 * Repositories fail CLOSED when tenantId is missing/blank.
 * @public
 */
export interface TenantScope {
  readonly tenantId: TenantId;
}

/** Optimistic-concurrency token; repositories reject stale writes with `version_conflict`. */
export type RowVersion = number;
