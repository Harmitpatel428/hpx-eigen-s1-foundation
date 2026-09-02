-- Drop personContactId column (model v2: isMain drives lead cache)
ALTER TABLE "Lead" DROP CONSTRAINT IF EXISTS "Lead_personContactId_fkey";
ALTER TABLE "Lead" DROP CONSTRAINT IF EXISTS "Lead_personContactId_key";
ALTER TABLE "Lead" DROP COLUMN IF EXISTS "personContactId";
