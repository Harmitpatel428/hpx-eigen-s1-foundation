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
