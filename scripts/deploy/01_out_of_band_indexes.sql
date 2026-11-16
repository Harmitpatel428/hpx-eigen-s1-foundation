-- 01 — Zero-downtime creation of Contact trigram search indexes on PRODUCTION.
--
-- Run OUT OF BAND, BEFORE `prisma migrate deploy`. CREATE INDEX CONCURRENTLY cannot run inside
-- Prisma's transactional migration wrapper, so it lives here. Idempotent (IF NOT EXISTS): a later
-- `migrate deploy` that declares the same indexes will no-op. Do NOT wrap in BEGIN/COMMIT
-- (CONCURRENTLY forbids running inside a transaction block).
--
--   psql -v ON_ERROR_STOP=1 -f scripts/deploy/01_out_of_band_indexes.sql "$PROD_DATABASE_URL"

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- New in 40992c8 (contact name/company search):
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_firstName_idx" ON "Contact" USING gin ("firstName" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_lastName_idx"  ON "Contact" USING gin ("lastName"  gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_company_idx"   ON "Contact" USING gin ("company"   gin_trgm_ops);
-- From R12 (migration 20261010000000) — included for idempotent completeness:
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_phone_idx"     ON "Contact" USING gin ("phone"     gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_email_idx"     ON "Contact" USING gin ("email"     gin_trgm_ops);

-- Verify: all five present, with size + scan counts.
SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE relname = 'Contact' AND indexrelname LIKE 'Contact\_%\_idx'
ORDER BY indexrelname;

-- Verify: none left INVALID (a failed CONCURRENTLY build leaves an invalid index — drop + re-create it).
SELECT c.relname AS invalid_index
FROM pg_class c
JOIN pg_index i ON i.indexrelid = c.oid
JOIN pg_class t ON t.oid = i.indrelid
WHERE t.relname = 'Contact' AND c.relname LIKE 'Contact\_%\_idx' AND NOT i.indisvalid;
