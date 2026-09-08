-- Add hashVersion column (default 0 for all existing rows = legacy link-only verification)
ALTER TABLE "AuditLog"
ADD COLUMN IF NOT EXISTS "hashVersion" INTEGER NOT NULL DEFAULT 0;

-- Index for chain-leaf lookup: find rows whose currentHash is referenced as a previousHash
CREATE INDEX IF NOT EXISTS "AuditLog_tenantId_previousHash_idx"
ON "AuditLog" ("tenantId", "previousHash");

-- Unique constraint on currentHash per tenant — detects duplicate hashes
CREATE UNIQUE INDEX IF NOT EXISTS "AuditLog_tenantId_currentHash_key"
ON "AuditLog" ("tenantId", "currentHash");
