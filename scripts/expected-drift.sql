-- Baseline drift accepted as permanent (Workstream F, drift item #4).
-- LeadPhone.@@index([phoneNormalized, tenantId]) in schema.prisma cannot
-- express the DB's actual partial predicate (WHERE "phoneNormalized" IS NOT
-- NULL, from migration 20260902000000_add_lead_phone_history) -- Prisma has
-- no declarative partial-index syntax. `prisma migrate diff` will therefore
-- always propose this CREATE INDEX; it must NEVER actually be run (duplicate
-- index name, same as the existing partial one -> fails).
--
-- scripts/check-drift.sh compares migrate diff's live output (comments
-- stripped) against this file (comments stripped) and fails CI if anything
-- ELSE shows up. If the schema legitimately changes and this baseline needs
-- to move, regenerate it with the same command against a scratch DB and
-- review the new output line by line before overwriting this file:
--   npx prisma migrate diff --from-migrations ./prisma/migrations \
--     --to-schema-datamodel ./prisma/schema.prisma \
--     --shadow-database-url <scratch-db-url> --script

-- CreateIndex
CREATE INDEX "LeadPhone_phoneNormalized_tenantId_idx" ON "LeadPhone"("phoneNormalized", "tenantId");
