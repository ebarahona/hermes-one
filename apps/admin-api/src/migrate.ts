// One-shot schema migration for a deployment: applies every pending migration to the authoritative
// store, then exits. Idempotent (applied files are skipped), so it is safe to run on every start.
// Runs under the configured (owner/migrator) connection, never the request-time platform_app role.
import {loadConfig} from '@hermes-one/config';
import {runMigrations} from '@hermes-one/drizzle';

try {
  const {applied, skipped} = await runMigrations(
    loadConfig().stores.authoritative.url,
  );
  console.log(
    `[migrate] applied ${applied.length}, already applied ${skipped.length}`,
  );
} catch (err) {
  console.error('[migrate] failed', err);
  process.exit(1);
}
