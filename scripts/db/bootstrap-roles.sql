-- bootstrap-roles.sql — STAGE 1 of the least-privilege role model (WP-0 / reg #19)
-- =============================================================================
-- WHY THIS EXISTS: production was once wiped by a destructive Prisma command run
-- with a single all-powerful DATABASE_URL. This splits that credential so the
-- running app can never issue DDL, and migrations run only as a dedicated role.
--
-- RUN AS: the current database owner (a superuser locally; on Render a managed,
--         NON-superuser owner role). Run ONCE per environment.
--
-- STAGE 1 (this file): create roles, transfer ownership to hpx_migrator, and give
--         hpx_app DML on existing + future tables (intermediate — so the app keeps
--         working during rollout). WP-3 flips ALTER DEFAULT PRIVILEGES to REVOKE
--         (deny-by-default) once every grant is emitted from the coverage matrix.
--
-- STATEMENT ORDER IS DELIBERATE AND PROD-SHAPED:
--   The role running this must be a MEMBER of hpx_migrator before REASSIGN OWNED
--   and before ALTER DEFAULT PRIVILEGES FOR ROLE hpx_migrator — Postgres requires
--   membership in both the giving and receiving roles. A LOCAL superuser owner
--   bypasses this check, which MASKS the bug; a PROD non-superuser owner FAILS
--   with "must have membership in role" if REASSIGN comes first. So we GRANT
--   membership FIRST. Do not reorder.
--
-- USAGE:
--   psql "<owner_url>" \
--     -v owner=<current_owner_role> \
--     -v migrator_pw="'...'" -v app_pw="'...'" -v ro_pw="'...'" \
--     -f scripts/db/bootstrap-roles.sql
--   (passwords are quoted literals: pass them WITH the surrounding single quotes,
--    e.g. -v app_pw="'s3cr3t'". Store real secrets in the secrets manager, never here.)
--
-- LOCAL PROOF NOTE: with trust auth on a disposable cluster the passwords are
--   ignored at connect time; the role GRANTS are what the proofs exercise.
-- =============================================================================

\set ON_ERROR_STOP on

-- 1) Roles ---------------------------------------------------------------------
--    NOSUPERUSER NOCREATEDB NOCREATEROLE — least privilege; only DML/DDL grants below.
CREATE ROLE hpx_migrator LOGIN PASSWORD :migrator_pw NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE hpx_app      LOGIN PASSWORD :app_pw      NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE hpx_readonly LOGIN PASSWORD :ro_pw       NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- 2) Membership FIRST (see header) --------------------------------------------
--    The owner must be a member of hpx_migrator to REASSIGN to it and to set its
--    default privileges. This GRANT is also the break-glass path: a human who is
--    <owner> can `SET ROLE hpx_migrator` to perform emergency DDL.
GRANT hpx_migrator TO :"owner";

-- 3) Schema ownership + privileges for the migrator ---------------------------
--    hpx_migrator owns the schema and every existing object, so it (and only it,
--    via CI `prisma migrate deploy`) can run DDL.
ALTER SCHEMA public OWNER TO hpx_migrator;
GRANT ALL ON SCHEMA public TO hpx_migrator;

-- 4) Transfer ownership of all existing objects to hpx_migrator ---------------
--    CRITICAL: without this, the first `ALTER TABLE` migration fails "must be
--    owner of table". Must come AFTER the membership grant in (2).
REASSIGN OWNED BY :"owner" TO hpx_migrator;

-- 5) App role: DML only, NO DDL ------------------------------------------------
--    USAGE (not CREATE) on the schema — so the app can reference objects but can
--    never CREATE/ALTER/DROP. On PG15+ the public schema grants no CREATE to
--    PUBLIC by default, so hpx_app has no path to DDL.
GRANT USAGE ON SCHEMA public TO hpx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO hpx_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO hpx_app;
--    Future tables created by the migrator auto-grant to hpx_app (STAGE 1 only;
--    WP-3 replaces this with REVOKE ALL + explicit matrix grants).
ALTER DEFAULT PRIVILEGES FOR ROLE hpx_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO hpx_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hpx_migrator IN SCHEMA public
  GRANT USAGE, SELECT                  ON SEQUENCES TO hpx_app;

-- 6) Read-only role: SELECT only ----------------------------------------------
--    (WP-3 tightens this to non-secret columns only — reg #22.)
GRANT USAGE ON SCHEMA public TO hpx_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO hpx_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE hpx_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO hpx_readonly;

-- =============================================================================
-- STAGE 2 (WP-3, NOT in this file): after the coverage-matrix generator is wired,
--   ALTER DEFAULT PRIVILEGES FOR ROLE hpx_migrator IN SCHEMA public
--     REVOKE ALL ON TABLES FROM hpx_app;   -- deny-by-default; grants become explicit
--   plus the remaining 9 roles (hpx_auth, hpx_billing, hpx_bootstrap, hpx_relay,
--   hpx_jobs, hpx_elevated, hpx_admin, hpx_audit_reader, hpx_recovery) + RLS.
-- =============================================================================
