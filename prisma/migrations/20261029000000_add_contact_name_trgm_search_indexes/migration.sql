-- Contact search (GET /api/v1/contacts?search=) ORs Prisma `contains` (ILIKE '%x%') across
-- firstName, lastName, email AND company. R12 (20261010000000) added trigram GIN on phone/email
-- only, so the name/company predicates still forced a full scan: EXPLAIN (ANALYZE, BUFFERS) on a
-- 150k-row "Contact" showed a Bitmap Heap Scan filtering ALL ~50k tenant rows per request —
-- findMany 145.9ms, count 142.7ms ("Rows Removed by Filter: 49998"). With trigram GIN on the
-- three remaining columns the OR becomes a BitmapOr of index scans: findMany 145.9ms -> 1.73ms,
-- count 142.7ms -> 2.05ms; route contacts_search p50 234ms -> 9ms (C=1) / 1060ms -> 46ms (C=10).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- IF NOT EXISTS: prod pre-creates these as non-blocking CREATE INDEX CONCURRENTLY builds (see the
-- Contact trigram section of docs/DEPLOYMENT.md) *before* `migrate deploy`, in which case these
-- statements no-op. CONCURRENTLY cannot run inside Prisma's transactional migration wrapper, so it
-- lives in the runbook, never in migration SQL — identical handling to Contact_phone/email_idx.
CREATE INDEX IF NOT EXISTS "Contact_firstName_idx" ON "Contact" USING GIN ("firstName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Contact_lastName_idx" ON "Contact" USING GIN ("lastName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Contact_company_idx" ON "Contact" USING GIN ("company" gin_trgm_ops);
