-- Create LeadStage enum (global stage model, separate from legacy LeadStatus).
-- Add stage, score, expectedValue, freeformAddress, customFieldValues to Lead.
-- These columns were added via db push on production but lacked a migration file.

CREATE TYPE "LeadStage" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED');

ALTER TABLE "Lead"
  ADD COLUMN "stage"             "LeadStage"    NOT NULL DEFAULT 'NEW',
  ADD COLUMN "score"             INTEGER        NOT NULL DEFAULT 0,
  ADD COLUMN "expectedValue"     DECIMAL(18,2)  NOT NULL DEFAULT 0,
  ADD COLUMN "freeformAddress"   TEXT,
  ADD COLUMN "customFieldValues" JSONB          NOT NULL DEFAULT '[]';
