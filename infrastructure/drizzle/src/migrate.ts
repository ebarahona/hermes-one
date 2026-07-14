// Numbered SQL migration runner. Applies infrastructure/drizzle/migrations/*.sql in filename order,
// each in its own transaction, recording applied files in a ledger table so re-runs are no-ops.
// Runs under a privileged (migrator/owner) connection — never the request-time platform_app role.
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {Pool} from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LEDGER = '_hermes_migrations';

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/** Apply all pending migrations. Idempotent: already-applied files are skipped. */
export async function runMigrations(url: string): Promise<MigrationResult> {
  const pool = new Pool({connectionString: url, max: 1});
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${LEDGER} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();
    const done = new Set(
      (await pool.query(`SELECT name FROM ${LEDGER}`)).rows.map(r => r.name as string),
    );
    for (const file of files) {
      if (done.has(file)) {
        skipped.push(file);
        continue;
      }
      const sqlText = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sqlText);
        await client.query(`INSERT INTO ${LEDGER} (name) VALUES ($1)`, [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, {cause: err});
      } finally {
        client.release();
      }
    }
    return {applied, skipped};
  } finally {
    await pool.end();
  }
}
