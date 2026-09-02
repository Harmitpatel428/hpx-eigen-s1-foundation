-- E3: Idempotent backfill — create person Contact for every Lead that lacks one.
-- Single CTE: INSERT...RETURNING feeds UPDATE in one statement.
-- isMain = true only when lead has zero non-deleted contacts; else false.
-- Idempotent: both halves guard on personContactId IS NULL.

WITH new_contacts AS (
  INSERT INTO "Contact" ("id", "tenantId", "leadId", "firstName", "lastName", "email", "phone", "company", "isMain", "createdAt", "updatedAt")
  SELECT
    gen_random_uuid(),
    l."tenantId",
    l."id",
    l."firstName",
    l."lastName",
    l."email",
    l."phone",
    l."company",
    NOT EXISTS (
      SELECT 1 FROM "Contact" c
      WHERE c."leadId" = l."id" AND c."deletedAt" IS NULL
    ),
    NOW(),
    NOW()
  FROM "Lead" l
  WHERE l."personContactId" IS NULL
    AND l."deletedAt" IS NULL
  RETURNING "id", "leadId"
)
UPDATE "Lead" l
SET "personContactId" = nc."id"
FROM new_contacts nc
WHERE l."id" = nc."leadId"
  AND l."personContactId" IS NULL;
