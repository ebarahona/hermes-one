-- Runs BEFORE any CREATE POLICY. Idempotent (CREATE ROLE guarded by a DO block).
-- platform_app is the non-bypassable request-time role RLS depends on; platform_migrator is the
-- more-privileged DDL/migration role. Neither is a superuser. (ADR-022, row-level-security.md)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'platform_app') THEN
    CREATE ROLE platform_app
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOBYPASSRLS         -- the precondition every RLS policy depends on
      NOREPLICATION
      CONNECTION LIMIT 200;
      -- auth is via IAM/cert per deploy environment; in local dev the app authenticates as the
      -- owner login and adopts this role via SET ROLE, so no LOGIN/PASSWORD is set here.
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'platform_migrator') THEN
    CREATE ROLE platform_migrator
      NOSUPERUSER
      CREATEDB            -- for ephemeral CI/test databases only
      NOBYPASSRLS;
  END IF;
END $$;
