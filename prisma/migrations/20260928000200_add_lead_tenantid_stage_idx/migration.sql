-- Drift item #3 (Workstream F forensics, wsF-report.md).
-- Commit 340c59d ("feat: stage filter + recent-work indicator on Leads page")
-- added @@index([tenantId, stage]) to schema.prisma but never shipped the
-- matching migration. Missing-migration case: schema is right, DB is behind.
-- (Prod: this index build can optionally be pre-applied as a lock-free,
-- non-transactional ops step ahead of `migrate deploy` — see
-- docs/DEPLOYMENT.md Workstream F apply sequence for the exact command;
-- this migration's IF NOT EXISTS guard no-ops if that already ran.)
CREATE INDEX IF NOT EXISTS "Lead_tenantId_stage_idx" ON "Lead" ("tenantId", "stage");
