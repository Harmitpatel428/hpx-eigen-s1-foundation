-- Partial unique indexes for TOCTOU-safe duplicate detection during lead import.
-- Covers only active (non-deleted) leads with a non-null email or phone.
-- Soft-deleted leads are excluded so their email/phone can be reused on re-import.
CREATE UNIQUE INDEX "Lead_tenantId_email_unique"
  ON "Lead"("tenantId", "email")
  WHERE email IS NOT NULL AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX "Lead_tenantId_phone_unique"
  ON "Lead"("tenantId", "phone")
  WHERE phone IS NOT NULL AND "deletedAt" IS NULL;
