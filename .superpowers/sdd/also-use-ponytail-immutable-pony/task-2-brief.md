# Task 2: Chain Repair Migration

## What to build

Create a Prisma migration that links orphaned AuditLog rows into the chain. Three existing writers (login, email verification, invitation acceptance) created rows with `previousHash: NULL` and random `currentHash` — these are disconnected from the chain and appear as false genesis entries.

This migration re-links ALL rows per tenant in `createdAt ASC` order so each tenant has exactly one genesis row (the first by createdAt) and every subsequent row's `previousHash` points to the preceding row's `currentHash`.

## File to create

`prisma/migrations/20260908020000_repair_orphaned_audit_rows/migration.sql`

## Migration SQL

```sql
-- Repair orphaned audit rows: re-link all rows per tenant by createdAt order.
-- Orphaned rows (from login/verify/invitation writers) have previousHash IS NULL
-- and random currentHash. This migration links them into a single chain per tenant.
--
-- Strategy:
--   1. For each tenant, order ALL rows by createdAt ASC, id ASC (tiebreaker)
--   2. The first row (true genesis) keeps previousHash = NULL
--   3. Every subsequent row gets previousHash = preceding row's currentHash
--   4. Existing currentHash values are PRESERVED — no content recomputation
--   5. All rows remain hashVersion = 0 (link-verified only)
--
-- This is idempotent: running it twice produces the same result because
-- it unconditionally sets previousHash based on createdAt ordering.

DO $$
DECLARE
  t_id UUID;
  r RECORD;
  prev_hash CHAR(64);
  row_num INTEGER;
BEGIN
  FOR t_id IN
    SELECT DISTINCT "tenantId" FROM "AuditLog"
  LOOP
    prev_hash := NULL;
    row_num := 0;

    FOR r IN
      SELECT "id", "currentHash"
      FROM "AuditLog"
      WHERE "tenantId" = t_id
      ORDER BY "createdAt" ASC, "id" ASC
    LOOP
      row_num := row_num + 1;

      IF row_num = 1 THEN
        -- Genesis row: ensure previousHash is NULL
        UPDATE "AuditLog"
        SET "previousHash" = NULL
        WHERE "id" = r."id"
          AND "previousHash" IS DISTINCT FROM NULL;
      ELSE
        -- Subsequent row: link to predecessor
        UPDATE "AuditLog"
        SET "previousHash" = prev_hash
        WHERE "id" = r."id"
          AND "previousHash" IS DISTINCT FROM prev_hash;
      END IF;

      prev_hash := r."currentHash";
    END LOOP;
  END LOOP;
END;
$$;
```

## No Prisma schema changes

This migration is data-only — no schema changes needed.

## Verification

After creating the migration file, verify the SQL is syntactically valid by checking that the file was written correctly. No runtime verification is possible without a database connection.

## Commit

```
fix: repair orphaned audit chain rows from login/verify/invitation writers
```

## Report

Write your report to: `.superpowers/sdd/also-use-ponytail-immutable-pony/task-2-report.md`

Report format:
- Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
- Commits: list SHA(s)
- One-line summary
- Concerns (if any)
