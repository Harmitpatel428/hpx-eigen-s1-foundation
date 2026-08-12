-- Lead visibility fix: track who last assigned a lead so managers retain visibility
-- after delegating to an executive.
--
-- ownerId  = current responsible person (the "doer")
-- managerId = the user who last changed ownerId (the "delegator")
--
-- OWN-scope visibility query becomes:
--   ownerId = $userId OR managerId = $userId
--
-- Existing rows get managerId = NULL; fix applies to new assignments going forward.
ALTER TABLE "Lead" ADD COLUMN "managerId" UUID;

CREATE INDEX "Lead_tenantId_managerId_idx" ON "Lead"("tenantId", "managerId");
