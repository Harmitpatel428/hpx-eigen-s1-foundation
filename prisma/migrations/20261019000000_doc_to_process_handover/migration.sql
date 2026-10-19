-- Documentation -> Process handover (Option B).
-- Scope: EXACTLY two DocCaseStatus values, two new enums (ProcessHandoffState,
-- ProcessReturnReason), the process-handoff columns on DocCase, and one index.
-- Nothing else. See .planning/doc-to-process-handover-design.md / -plan.md.
--
-- REVERSIBILITY / FORWARD-ONLY NOTE:
--   * The ADD COLUMN / CREATE INDEX statements are fully reversible (DROP COLUMN /
--     DROP INDEX).
--   * `ALTER TYPE ... ADD VALUE` is FORWARD-ONLY in PostgreSQL: an enum value
--     cannot be dropped without recreating the type and rewriting every column
--     that uses it. Rollback of this migration therefore drops the new columns
--     and index and LEAVES the two unused DocCaseStatus values and the two new
--     enum types in place (harmless — nothing references them after a rollback).
--   * Safe inside a transaction on PG 12+ because none of the new values are
--     referenced by DML in this migration (same pattern as
--     20260830000000_phase_1b_handoff_portal).

-- ─── DocCaseStatus: two new states (TRANSFERRED_TO_PROCESS unchanged) ────────
ALTER TYPE "DocCaseStatus" ADD VALUE IF NOT EXISTS 'PENDING_PROCESS_REVIEW';
ALTER TYPE "DocCaseStatus" ADD VALUE IF NOT EXISTS 'RETURNED_TO_DOCUMENTATION';

-- ─── New enums ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ProcessHandoffState" AS ENUM (
    'NONE', 'PENDING_REVIEW', 'ACCEPTED', 'RETURNED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ProcessReturnReason" AS ENUM (
    'MISSING_DOCUMENT', 'INCORRECT_DOCUMENT', 'DATA_MISMATCH',
    'NEEDS_CLARIFICATION', 'COMPLIANCE_ISSUE', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── DocCase: process-handoff columns ───────────────────────────────────────
ALTER TABLE "DocCase"
  ADD COLUMN IF NOT EXISTS "processHandoffState"     "ProcessHandoffState" NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "processHandoffAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processHandoffBy"        UUID,
  ADD COLUMN IF NOT EXISTS "processAssignedTo"       UUID,
  ADD COLUMN IF NOT EXISTS "processAcceptedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processAcceptedBy"       UUID,
  ADD COLUMN IF NOT EXISTS "processReturnedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processReturnCount"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "processReturnReasonCode" "ProcessReturnReason",
  ADD COLUMN IF NOT EXISTS "processReturnReasonNote" TEXT,
  ADD COLUMN IF NOT EXISTS "handoverRemarks"         TEXT;

-- ─── Process queue scan index ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "DocCase_tenantId_processHandoffState_idx"
  ON "DocCase"("tenantId", "processHandoffState");
