-- Admin impersonation support
-- Session: tracks which admin initiated the impersonation (null = normal session)
ALTER TABLE "Session" ADD COLUMN "impersonatedByUserId" UUID;

-- TenantSettings: org-level toggle; OFF by default — backend enforces, not just frontend
ALTER TABLE "TenantSettings" ADD COLUMN "allowImpersonation" BOOLEAN NOT NULL DEFAULT false;
