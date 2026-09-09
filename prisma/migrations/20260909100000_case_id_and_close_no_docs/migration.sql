-- Add missing close/reopen tracking columns to DocCase (non-destructive).
-- caseNumber and closedAt already exist from prior migrations.
ALTER TABLE "DocCase" ADD COLUMN IF NOT EXISTS "closedReason"      TEXT;
ALTER TABLE "DocCase" ADD COLUMN IF NOT EXISTS "closedByUserId"    UUID;
ALTER TABLE "DocCase" ADD COLUMN IF NOT EXISTS "reopenedAt"        TIMESTAMP(3);
ALTER TABLE "DocCase" ADD COLUMN IF NOT EXISTS "reopenedByUserId"  UUID;

-- New status value for cases closed without documentation.
ALTER TYPE "DocCaseStatus" ADD VALUE IF NOT EXISTS 'CLOSED_NO_DOCS';

-- Composite index for closed-case queries (status + closedAt).
CREATE INDEX IF NOT EXISTS "DocCase_status_closedAt_idx"
  ON "DocCase" ("status", "closedAt");
