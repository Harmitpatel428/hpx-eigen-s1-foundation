-- ============================================================================
-- Migration: Lead Stage Redesign + Lead Operational Timeline
--
-- Safe migration strategy:
--   - ADD new LeadStage enum values (FOLLOW_UP, CALL_BACK_REQUESTED,
--     CALL_NOT_RECEIVED, OTHER). Existing values CONTACTED and CONVERTED
--     are retained for backward-compatible historical records.
--   - ADD followUpDate column (nullable) to Lead.
--   - CREATE LeadActivityType and LeadActivityState enums.
--   - CREATE LeadActivity table for the Lead-scoped operational timeline.
--
-- No destructive changes. No data migration required.
-- Rollback: remove the new columns/tables/enum values (enum value removal
--   requires PostgreSQL 14+ pg_enum manipulation or a full type rebuild).
-- ============================================================================

-- ── 1. Extend LeadStage enum (PostgreSQL: ADD VALUE per statement) ─────────────
-- Note: IF NOT EXISTS is supported in PostgreSQL 9.3+
ALTER TYPE "LeadStage" ADD VALUE IF NOT EXISTS 'FOLLOW_UP';
ALTER TYPE "LeadStage" ADD VALUE IF NOT EXISTS 'CALL_BACK_REQUESTED';
ALTER TYPE "LeadStage" ADD VALUE IF NOT EXISTS 'CALL_NOT_RECEIVED';
ALTER TYPE "LeadStage" ADD VALUE IF NOT EXISTS 'OTHER';

-- ── 2. Add followUpDate to Lead ─────────────────────────────────────────────────
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "followUpDate" TIMESTAMP(3);

-- ── 3. Create LeadActivityType enum ────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "LeadActivityType" AS ENUM (
    'STAGE_CHANGE',
    'FOLLOW_UP_SCHEDULED',
    'CALLBACK_SCHEDULED',
    'CALL_NOT_RECEIVED_EVENT',
    'ASSIGNMENT_CHANGE',
    'LEAD_CREATED',
    'NOTE_ADDED',
    'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 4. Create LeadActivityState enum ────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "LeadActivityState" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 5. Create LeadActivity table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "LeadActivity" (
  "id"          UUID                  NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID                  NOT NULL,
  "leadId"      UUID                  NOT NULL,
  "actorUserId" UUID,
  "type"        "LeadActivityType"    NOT NULL,
  "state"       "LeadActivityState"   NOT NULL DEFAULT 'COMPLETED',
  "subject"     TEXT                  NOT NULL,
  "metadata"    JSONB                 NOT NULL DEFAULT '{}',
  "scheduledAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"   TIMESTAMP(3),
  CONSTRAINT "LeadActivity_pkey" PRIMARY KEY ("id")
);

-- ── 6. Foreign key: LeadActivity → Lead ─────────────────────────────────────────
ALTER TABLE "LeadActivity" DROP CONSTRAINT IF EXISTS "LeadActivity_leadId_fkey";
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 7. Indexes ───────────────────────────────────────────────────────────────────
-- Composite for timeline list query (tenantId scoping + leadId + ordering)
CREATE INDEX IF NOT EXISTS "LeadActivity_tenantId_leadId_idx"
  ON "LeadActivity"("tenantId", "leadId");

CREATE INDEX IF NOT EXISTS "LeadActivity_tenantId_leadId_createdAt_idx"
  ON "LeadActivity"("tenantId", "leadId", "createdAt" DESC);

-- For filtering by pending activities
CREATE INDEX IF NOT EXISTS "LeadActivity_leadId_state_idx"
  ON "LeadActivity"("leadId", "state");

-- Soft-delete filter
CREATE INDEX IF NOT EXISTS "LeadActivity_deletedAt_idx"
  ON "LeadActivity"("deletedAt");
