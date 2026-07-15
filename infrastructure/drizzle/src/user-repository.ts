// DrizzleUserRepository — the tenant-scoped user/principal-at-rest surface over `tenant.users`
// (api/admin-api.md §UserController; database/table-catalog.md). Backs `user|service|system`
// principals (agent principals are never persisted). Self-scoping via withTenant (RLS keys on
// tenant_id). A per-tenant unique (email / externalHandle / auth-identity) collision → 409 conflict.
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {PlatformErrorException, type TenantId} from '@platform/contracts';
import {TenantAwareRepository} from './tenant-aware.repository.js';
import {users} from './schema/tenant.schema.js';

export type UserKind = 'user' | 'service' | 'system';

/** CreateUserRequest minus server-derived columns (admin-api.md). */
export interface UserCreateInput {
  kind: UserKind;
  displayName?: string;
  email?: string;
  externalHandle?: string;
  roleNames?: string[];
  attributes?: Record<string, string | number | boolean | null>;
}

/** UserDto (admin-api.md) — the public projection of a user row. */
export interface UserDto {
  principalId: string;
  tenantId: string;
  kind: UserKind;
  displayName: string | null;
  email: string | null;
  roleNames: string[];
  status: 'active' | 'suspended';
}

type UserRow = typeof users.$inferSelect;

function toDto(row: UserRow): UserDto {
  return {
    principalId: row.principalId,
    tenantId: row.tenantId,
    kind: row.kind,
    displayName: row.displayName ?? null,
    email: row.email ?? null,
    roleNames: row.roleNames,
    status: row.status,
  };
}

export class DrizzleUserRepository extends TenantAwareRepository {
  async createUser(tenantId: TenantId, input: UserCreateInput): Promise<UserDto> {
    const principalId = `prn_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    try {
      return await this.withTenant({tenantId}, async tx => {
        const [row] = await tx
          .insert(users)
          .values({
            principalId,
            tenantId,
            kind: input.kind,
            displayName: input.displayName ?? null,
            email: input.email ?? null,
            externalHandle: input.externalHandle ?? null,
            roleNames: input.roleNames ?? [],
            attributes: input.attributes ?? {},
          })
          .returning();
        return toDto(row);
      });
    } catch (err) {
      // drizzle wraps the pg error ("Failed query: …") — the SQLSTATE is on the cause.
      const code = (err as {code?: string}).code ?? (err as {cause?: {code?: string}}).cause?.code;
      if (code === '23505') {
        throw new PlatformErrorException({
          category: 'conflict',
          code: 'idempotency_conflict', // closest fixed code; a duplicate email/handle/identity
          message: 'A user with this email, handle, or identity already exists for the tenant.',
          issues: [],
          retryable: false,
          httpStatus: 409,
        });
      }
      throw err;
    }
  }

  async listUsers(tenantId: TenantId): Promise<UserDto[]> {
    return this.withTenant({tenantId}, async tx => {
      const rows = await tx.select().from(users).where(eq(users.tenantId, tenantId));
      return rows.map(toDto);
    });
  }
}
