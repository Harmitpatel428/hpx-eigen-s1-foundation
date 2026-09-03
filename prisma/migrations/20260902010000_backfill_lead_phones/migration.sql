-- Backfill LeadPhone from Lead.phone + Contact.phone
-- Idempotent: skips rows that already exist (ON CONFLICT DO NOTHING).
-- Batched via a single INSERT...SELECT — PostgreSQL handles this atomically.

-- Helper: normalize phone digits (matches src/utils/phone.util.ts logic)
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

-- 1. Backfill from Lead.phone (primary, source = BACKFILL)
INSERT INTO "LeadPhone" ("id", "tenantId", "leadId", "phoneOriginal", "phoneNormalized", "status", "isPrimary", "source", "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  l."tenantId",
  l."id",
  l."phone",
  _tmp_normalize_phone(l."phone"),
  'ACTIVE'::"LeadPhoneStatus",
  true,
  'BACKFILL'::"LeadPhoneSource",
  NOW(),
  NOW()
FROM "Lead" l
WHERE l."phone" IS NOT NULL
  AND l."phone" <> ''
  AND l."deletedAt" IS NULL
ON CONFLICT ("leadId", "phoneNormalized")
  WHERE "phoneNormalized" IS NOT NULL
  DO NOTHING;

-- 2. Backfill from Contact.phone (non-primary, source = BACKFILL)
INSERT INTO "LeadPhone" ("id", "tenantId", "leadId", "phoneOriginal", "phoneNormalized", "status", "isPrimary", "source", "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  c."tenantId",
  c."leadId",
  c."phone",
  _tmp_normalize_phone(c."phone"),
  'ACTIVE'::"LeadPhoneStatus",
  false,
  'BACKFILL'::"LeadPhoneSource",
  NOW(),
  NOW()
FROM "Contact" c
WHERE c."phone" IS NOT NULL
  AND c."phone" <> ''
  AND c."leadId" IS NOT NULL
  AND c."deletedAt" IS NULL
ON CONFLICT ("leadId", "phoneNormalized")
  WHERE "phoneNormalized" IS NOT NULL
  DO NOTHING;

-- R9: isMain-contact phone wins as primary when both lead.phone and
-- isMain contact.phone exist for the same lead. Idempotent: only
-- flips rows that still need correction.
UPDATE "LeadPhone" lp
SET "isPrimary" = true
FROM "Contact" c
WHERE c."isMain" = true
  AND c."deletedAt" IS NULL
  AND c."phone" IS NOT NULL
  AND c."phone" <> ''
  AND c."leadId" = lp."leadId"
  AND lp."phoneNormalized" = _tmp_normalize_phone(c."phone")
  AND lp."status" = 'ACTIVE'
  AND lp."isPrimary" = false;

-- Unset old primary where isMain-contact correction promoted a different row
UPDATE "LeadPhone" lp
SET "isPrimary" = false
FROM "LeadPhone" winner
WHERE winner."leadId" = lp."leadId"
  AND winner."id" <> lp."id"
  AND winner."isPrimary" = true
  AND lp."isPrimary" = true
  AND lp."source" = 'BACKFILL'
  AND winner."source" = 'BACKFILL';

-- Cleanup
DROP FUNCTION IF EXISTS _tmp_normalize_phone(TEXT);
