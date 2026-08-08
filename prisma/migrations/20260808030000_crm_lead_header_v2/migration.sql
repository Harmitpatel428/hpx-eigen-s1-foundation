-- Migration: crm_lead_header_v2
-- Removes the 'phone' option and one-time-lock model.
-- Makes leadHeaderPreference a mutable org-level setting with 'name' as the default.

-- Step 1: Backfill — migrate 'phone' and NULL rows to 'name'
UPDATE "TenantSettings"
SET "leadHeaderPreference" = 'name'
WHERE "leadHeaderPreference" IS NULL OR "leadHeaderPreference" = 'phone';

-- Step 2: Set DB-level default
ALTER TABLE "TenantSettings"
  ALTER COLUMN "leadHeaderPreference" SET DEFAULT 'name';

-- Step 3: Make NOT NULL (all rows have a value after Step 1)
ALTER TABLE "TenantSettings"
  ALTER COLUMN "leadHeaderPreference" SET NOT NULL;

-- Step 4: Add CHECK constraint — defense-in-depth; app layer also validates
ALTER TABLE "TenantSettings"
  ADD CONSTRAINT "TenantSettings_leadHeaderPreference_check"
  CHECK ("leadHeaderPreference" IN ('name', 'company'));
