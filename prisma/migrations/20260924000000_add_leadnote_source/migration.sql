-- F2: provenance tag on lead notes. Enables a tagged, reversible backfill of legacy Lead.notes
-- free-text into the leadNote table (scripts/backfill-legacy-notes.ts). Non-destructive: adds one
-- column with a safe default; existing rows become 'user'.
ALTER TABLE "LeadNote" ADD COLUMN "source" VARCHAR(32) NOT NULL DEFAULT 'user';
