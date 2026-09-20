-- Firm direct upload (Phase 1): new DocEventType values.
-- Isolated migration — no other statements and no same-transaction USE of the new
-- values (PG requires ALTER TYPE ... ADD VALUE not be used in the tx that adds it).
-- DOCUMENT_STATUS_CHANGED already exists in the enum and is reused (not re-added).
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'MANDATE_FIRM_UPLOADED';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'DOCUMENT_UPLOADED';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'DOCUMENT_REPLACED';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'DOCUMENT_REMOVED';
