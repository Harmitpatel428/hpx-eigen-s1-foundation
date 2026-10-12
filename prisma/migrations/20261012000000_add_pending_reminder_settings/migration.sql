-- Copy Pending Documents reminder: org-level template + organization name on TenantSettings.
-- NULL = use frontend defaults. DB-level length guard mirrors the app validation.
ALTER TABLE "TenantSettings" ADD COLUMN "pendingReminderTemplate" TEXT CHECK (char_length("pendingReminderTemplate") <= 10000);
ALTER TABLE "TenantSettings" ADD COLUMN "pendingReminderOrgName" TEXT CHECK (char_length("pendingReminderOrgName") <= 200);
