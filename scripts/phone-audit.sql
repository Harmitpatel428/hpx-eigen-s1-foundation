-- Phone data audit — run manually against a staging/prod copy.
-- Reports: counts, duplicates within/across leads, malformed numbers.

-- Helper (same logic as normalizePhone in phone.util.ts)
CREATE OR REPLACE FUNCTION _tmp_normalize_phone(input TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  digits TEXT;
BEGIN
  digits := regexp_replace(input, '\D', '', 'g');
  IF length(digits) = 12 AND digits LIKE '91%' THEN
    digits := substring(digits FROM 3);
  END IF;
  IF length(digits) < 6 THEN
    RETURN NULL;
  END IF;
  RETURN digits;
END;
$$;

-- 1. Leads with phone
SELECT 'leads_with_phone' AS metric, COUNT(*) AS cnt
FROM "Lead" WHERE "phone" IS NOT NULL AND "phone" <> '' AND "deletedAt" IS NULL;

-- 2. Contacts with phone
SELECT 'contacts_with_phone' AS metric, COUNT(*) AS cnt
FROM "Contact" WHERE "phone" IS NOT NULL AND "phone" <> '' AND "deletedAt" IS NULL;

-- 3. Duplicate normalized numbers WITHIN a lead
SELECT 'dup_within_lead' AS metric, COUNT(*) AS cnt FROM (
  SELECT l."id", _tmp_normalize_phone(src.phone) AS norm, COUNT(*) AS n
  FROM "Lead" l
  JOIN (
    SELECT "id" AS src_id, "phone", "tenantId" FROM "Lead" WHERE "phone" IS NOT NULL AND "phone" <> '' AND "deletedAt" IS NULL
    UNION ALL
    SELECT "id", "phone", "tenantId" FROM "Contact" WHERE "phone" IS NOT NULL AND "phone" <> '' AND "leadId" IS NOT NULL AND "deletedAt" IS NULL
  ) src ON l."id" = src.src_id OR l."id" = (SELECT "leadId" FROM "Contact" WHERE "id" = src.src_id)
  WHERE l."deletedAt" IS NULL AND _tmp_normalize_phone(src.phone) IS NOT NULL
  GROUP BY l."id", norm
  HAVING COUNT(*) > 1
) dupes;

-- 4. Duplicate normalized numbers ACROSS leads (same tenant)
SELECT 'dup_across_leads' AS metric, norm, COUNT(DISTINCT lead_id) AS lead_count FROM (
  SELECT "id" AS lead_id, "tenantId", _tmp_normalize_phone("phone") AS norm
  FROM "Lead" WHERE "phone" IS NOT NULL AND "phone" <> '' AND "deletedAt" IS NULL AND _tmp_normalize_phone("phone") IS NOT NULL
) t
GROUP BY "tenantId", norm
HAVING COUNT(DISTINCT lead_id) > 1
ORDER BY lead_count DESC
LIMIT 20;

-- 5. Malformed (< 6 digits after normalization)
SELECT 'malformed_lead_phones' AS metric, COUNT(*) AS cnt
FROM "Lead" WHERE "phone" IS NOT NULL AND "phone" <> '' AND "deletedAt" IS NULL
AND _tmp_normalize_phone("phone") IS NULL;

SELECT 'malformed_contact_phones' AS metric, COUNT(*) AS cnt
FROM "Contact" WHERE "phone" IS NOT NULL AND "phone" <> '' AND "deletedAt" IS NULL
AND _tmp_normalize_phone("phone") IS NULL;

-- 6. EXPLAIN ANALYZE — verify index scan on phoneNormalized lookup
EXPLAIN ANALYZE
SELECT l."id" FROM "Lead" l
JOIN "LeadPhone" lp ON lp."leadId" = l."id"
WHERE lp."phoneNormalized" = '9876543210'
  AND lp."tenantId" = '00000000-0000-0000-0000-000000000000'
LIMIT 10;

-- 7. SQL/TS normalization parity — 10 fixture vectors
-- Expected outputs must match normalizePhone() in phone.util.ts exactly.
-- Run after backfill; all rows should return 'PASS'.
SELECT input, expected,
  CASE WHEN _tmp_normalize_phone(input) IS NOT DISTINCT FROM expected THEN 'PASS' ELSE 'FAIL: got ' || COALESCE(_tmp_normalize_phone(input), 'NULL') END AS result
FROM (VALUES
  ('919876543210',       '9876543210'),
  ('+91 98765 43210',    '9876543210'),
  ('91-9876543210',      '9876543210'),
  ('9876543210',         '9876543210'),
  ('441234567890',       '441234567890'),
  ('1234567890',         '1234567890'),
  ('9198765432101',      '9198765432101'),
  ('91987654321',        '91987654321'),
  ('12345',              NULL),
  ('abc',                NULL)
) AS fixtures(input, expected);

-- Cleanup
DROP FUNCTION IF EXISTS _tmp_normalize_phone(TEXT);
