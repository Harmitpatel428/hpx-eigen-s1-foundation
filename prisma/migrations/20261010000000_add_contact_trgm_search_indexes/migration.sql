-- Lead search matches contact phone/email with Prisma `contains` (ILIKE '%x%'). A b-tree cannot
-- serve a leading wildcard, so EXPLAIN (ANALYZE, BUFFERS) on a 150k-row "Contact" showed the two
-- `contacts.some` semi-joins running as full Seq Scans on every search request:
--   SubPlan phone 301.8ms + SubPlan email 23.0ms  (search query exec 379.9ms)
-- With trigram GIN both become Bitmap Index Scans (0.053ms / 0.011ms), exec 379.9ms -> 76.0ms,
-- and the route p50 drops 617ms -> 293ms.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- IF NOT EXISTS: prod may pre-create these as non-blocking index builds (see the Contact trigram
-- section of docs/DEPLOYMENT.md) *before* `migrate deploy`, in which case these statements no-op.
-- Non-blocking builds cannot run inside Prisma's transactional migration wrapper, so they live in
-- the runbook and never in migration SQL.
CREATE INDEX IF NOT EXISTS "Contact_phone_idx" ON "Contact" USING GIN ("phone" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Contact_email_idx" ON "Contact" USING GIN ("email" gin_trgm_ops);
