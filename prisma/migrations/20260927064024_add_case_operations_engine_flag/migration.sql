-- Phase 1 (A): tenant-level kill switch for the Case Operations Engine.
-- Additive only — new column with a safe default; no data migration needed.

ALTER TABLE "TenantSettings" ADD COLUMN "caseOperationsEngineEnabled" BOOLEAN NOT NULL DEFAULT false;
