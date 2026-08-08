-- AddColumn TenantSettings.leadHeaderPreference
-- NULL = unconfigured; 'name' | 'company' | 'phone' = immutable once set
ALTER TABLE "TenantSettings" ADD COLUMN "leadHeaderPreference" TEXT;
