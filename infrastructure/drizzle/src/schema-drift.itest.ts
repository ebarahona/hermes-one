// Schema↔DB drift gate (deferral-ledger I1). Our numbered migrations carry RLS/roles/grants/views that
// drizzle-kit cannot model, so a "generated SQL == migrations" check is impossible. Instead we assert the
// ONLY drift that can break runtime: the columns/types/nullability the app queries THROUGH (the Drizzle
// `*.schema.ts` table defs, source of truth for every query) must match what the applied migrations
// actually build in Postgres. Runs after `runMigrations` against the live stack (integration job).
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {getTableConfig, PgTable, type PgColumn} from 'drizzle-orm/pg-core';
import {is} from 'drizzle-orm';
import {loadConfig} from '@platform-internal/config';
import {runMigrations} from './migrate.js';
import * as substrate from './schema/substrate.schema.js';
import * as runtime from './schema/runtime.schema.js';
import * as audit from './schema/audit.schema.js';
import * as tenant from './schema/tenant.schema.js';
import * as capability from './schema/capability.schema.js';
import * as event from './schema/event.schema.js';

const PG = loadConfig().stores.authoritative.url;

/** Every modeled table across all schema modules (excludes pgSchema/relation/zod exports). */
const MODELED: readonly PgTable[] = [substrate, runtime, audit, tenant, capability, event]
  .flatMap(mod => Object.values(mod))
  .filter((v): v is PgTable => is(v, PgTable));

interface DbColumn {
  readonly dataType: string; // information_schema.columns.data_type (lowercased)
  readonly udtName: string; // .udt_name — needed to resolve ARRAY element type
  readonly nullable: boolean; // is_nullable = 'YES'
}

/** Normalize a Drizzle column's SQL type to an information_schema-comparable token. */
function drizzleType(col: PgColumn): string {
  const t = col.getSQLType().toLowerCase();
  // serial pseudo-types create an integer/bigint column + a sequence default; the DB reports the
  // underlying integer type, not 'serial'.
  if (t === 'serial') return 'integer';
  if (t === 'bigserial') return 'bigint';
  if (t === 'smallserial') return 'smallint';
  return t;
}

/** Normalize an information_schema row to the same token space as {@link drizzleType}. */
function dbType(c: DbColumn): string {
  // ARRAY columns report data_type='ARRAY' + udt_name='_text'; drizzle reports 'text[]'.
  if (c.dataType === 'array') return `${c.udtName.replace(/^_/, '')}[]`;
  return c.dataType;
}

let owner: Pool;

beforeAll(async () => {
  await runMigrations(PG);
  owner = new Pool({connectionString: PG, max: 2});
});

afterAll(async () => {
  await owner?.end();
});

describe('schema↔DB drift gate (live)', () => {
  it('models every table the migrations build', () => {
    // Sanity: the six modules must contribute the full catalog we expect to guard.
    expect(MODELED.length).toBeGreaterThanOrEqual(15);
  });

  it.each(MODELED.map(t => [`${getTableConfig(t).schema}.${getTableConfig(t).name}`, t] as const))(
    '%s columns/types/nullability match the applied migration',
    async (_label, table) => {
      const cfg = getTableConfig(table);
      const schemaName = cfg.schema ?? 'public';

      const res = await owner.query<{
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, udt_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2`,
        [schemaName, cfg.name],
      );
      // The table must exist (migrations built it).
      expect(res.rowCount, `${schemaName}.${cfg.name} is not present in the DB`).toBeGreaterThan(0);

      const dbCols = new Map<string, DbColumn>(
        res.rows.map(r => [
          r.column_name,
          {dataType: r.data_type.toLowerCase(), udtName: r.udt_name.toLowerCase(), nullable: r.is_nullable === 'YES'},
        ]),
      );

      // Columns that are NOT NULL in the DB regardless of an explicit .notNull() on the def:
      // every member of a (single- or composite-) primary key.
      const pkCols = new Set<string>([
        ...cfg.columns.filter(c => c.primary).map(c => c.name),
        ...cfg.primaryKeys.flatMap(pk => pk.columns.map(c => c.name)),
      ]);

      for (const col of cfg.columns) {
        const db = dbCols.get(col.name);
        expect(db, `column ${cfg.name}.${col.name} missing in DB`).toBeDefined();
        if (!db) continue;

        expect(dbType(db), `type mismatch on ${cfg.name}.${col.name}`).toBe(drizzleType(col));

        const modeledNotNull = col.notNull || pkCols.has(col.name);
        expect(db.nullable, `nullability mismatch on ${cfg.name}.${col.name}`).toBe(!modeledNotNull);
      }

      // Reverse drift: a migration adding a column the schema def doesn't model would make the app
      // blind to it — flag that too.
      const modeledNames = new Set(cfg.columns.map(c => c.name));
      const unmodeled = [...dbCols.keys()].filter(n => !modeledNames.has(n));
      expect(unmodeled, `DB has columns ${cfg.name} schema def does not model`).toEqual([]);
    },
  );
});
