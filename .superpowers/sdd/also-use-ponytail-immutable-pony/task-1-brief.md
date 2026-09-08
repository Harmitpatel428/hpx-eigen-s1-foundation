# Task 1: Schema Migration — hashVersion Column + Indexes

## What to build

Create a Prisma migration that adds a `hashVersion` column to the `AuditLog` table and two new indexes. Then update the Prisma schema to match.

## Files to create/modify

1. **Create:** `prisma/migrations/20260908010000_audit_hash_version_and_indexes/migration.sql`
2. **Modify:** `prisma/schema.prisma` — the `AuditLog` model (currently at lines 321-343)

## Migration SQL (exact)

```sql
-- Add hashVersion column (default 0 for all existing rows = legacy link-only verification)
ALTER TABLE "AuditLog"
ADD COLUMN IF NOT EXISTS "hashVersion" INTEGER NOT NULL DEFAULT 0;

-- Index for chain-leaf lookup: find rows whose currentHash is referenced as a previousHash
CREATE INDEX IF NOT EXISTS "AuditLog_tenantId_previousHash_idx"
ON "AuditLog" ("tenantId", "previousHash");

-- Unique constraint on currentHash per tenant — detects duplicate hashes
CREATE UNIQUE INDEX IF NOT EXISTS "AuditLog_tenantId_currentHash_key"
ON "AuditLog" ("tenantId", "currentHash");
```

## Prisma schema update (exact)

The current AuditLog model is:

```prisma
model AuditLog {
  id             String   @id @default(uuid()) @db.Uuid
  tenantId       String   @db.Uuid
  eventType      String
  entityType     String
  entityId       String
  actorUserId    String?  @db.Uuid
  actorIp        String?
  actorUserAgent String?
  operation      String
  payload        Json
  beforeState    Json?
  afterState     Json?
  correlationId  String?  @db.Uuid
  previousHash   String?  @db.Char(64)
  currentHash    String   @db.Char(64)
  createdAt      DateTime @default(now())

  @@index([tenantId, createdAt])
  @@index([correlationId])
  @@index([entityType, entityId])
  @@index([currentHash])
}
```

Change it to:

```prisma
model AuditLog {
  id             String   @id @default(uuid()) @db.Uuid
  tenantId       String   @db.Uuid
  eventType      String
  entityType     String
  entityId       String
  actorUserId    String?  @db.Uuid
  actorIp        String?
  actorUserAgent String?
  operation      String
  payload        Json
  beforeState    Json?
  afterState     Json?
  correlationId  String?  @db.Uuid
  previousHash   String?  @db.Char(64)
  currentHash    String   @db.Char(64)
  hashVersion    Int      @default(0)
  createdAt      DateTime @default(now())

  @@unique([tenantId, currentHash])
  @@index([tenantId, createdAt])
  @@index([tenantId, previousHash])
  @@index([correlationId])
  @@index([entityType, entityId])
}
```

Key changes:
- Added `hashVersion Int @default(0)` field
- Added `@@unique([tenantId, currentHash])` — replaces the old `@@index([currentHash])`
- Added `@@index([tenantId, previousHash])` for chain-leaf lookups
- Removed `@@index([currentHash])` since the unique constraint covers it

## STOP CONDITION

If `npx prisma validate` fails after the schema update, fix it before committing. If the unique index would fail on existing data (duplicate currentHash within a tenant), stop and report the collision — do NOT proceed.

## Commit

Stage both files and commit:
```
feat: add hashVersion column and chain-integrity indexes to AuditLog
```

## Report

Write your report to: `.superpowers/sdd/also-use-ponytail-immutable-pony/task-1-report.md`

Report format:
- Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
- Commits: list SHA(s)
- One-line test summary (prisma validate result)
- Concerns (if any)
