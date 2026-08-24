-- Add INTERESTED to the active selectable lead stages.
-- Safe inside a transaction on PG 12+: the new value is not used in this migration.
ALTER TYPE "LeadStage" ADD VALUE 'INTERESTED';
