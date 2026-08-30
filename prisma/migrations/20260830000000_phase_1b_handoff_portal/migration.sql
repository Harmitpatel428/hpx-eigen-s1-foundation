-- Phase 1-B: Handoff workflow + Client Portal backend realisation.
--
-- Enum additions are safe inside a transaction on PG 12+ because none of the new
-- values are referenced by DML in this migration (same pattern as
-- 20260823010000_add_interested_stage).

-- ─── DocCaseStatus: add the two genuinely new states ────────────────────────
-- DOCUMENTATION_READY and TRANSFERRED_TO_PROCESS are kept under their existing
-- names rather than renamed to READY_FOR_PROCESS / TRANSFERRED: a rename would
-- rewrite live rows and break the frontend status label maps for no behavioural
-- gain. INCOMING and RETURNED are the only states that did not already exist.
ALTER TYPE "DocCaseStatus" ADD VALUE IF NOT EXISTS 'INCOMING';
ALTER TYPE "DocCaseStatus" ADD VALUE IF NOT EXISTS 'RETURNED';

-- ─── DocEventType: handoff + portal audit events ────────────────────────────
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'HANDOFF_CREATED';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'HANDOFF_ACCEPTED';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'HANDOFF_REJECTED';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'CASE_RETURNED';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'HANDOFF_RESENT';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'HANDOFF_AUTO_DROPPED';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'MANAGER_REVIEW_COMPLETED';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'CLIENT_VISIBLE_PUBLISHED';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'PORTAL_CONTACT_CHANGE_REQUESTED';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'PORTAL_CONTACT_CHANGE_APPROVED';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'PORTAL_SESSION_REVOKED';

-- ─── New enums ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "HandoffState" AS ENUM (
    'NONE', 'HANDED_OFF', 'ACCEPTED', 'RETURNED', 'RESENT',
    'MANAGER_REVIEW_REQUIRED', 'AUTO_DROPPED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PortalPhoneSource" AS ENUM ('LEAD_SNAPSHOT', 'NOMINATED_OVERRIDE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PortalContactChangeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "HandoffReturnReason" AS ENUM (
    'WRONG_OR_MISSING_CONTACT', 'WRONG_PRESET', 'INCOMPLETE_INFORMATION',
    'DUPLICATE_CASE', 'COMPLIANCE_ISSUE', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── DocCase: handoff + portal columns ──────────────────────────────────────
ALTER TABLE "DocCase"
  ADD COLUMN IF NOT EXISTS "caseNumber"                 TEXT,
  ADD COLUMN IF NOT EXISTS "handoffState"               "HandoffState" NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "handoffAt"                  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "handoffBy"                  UUID,
  ADD COLUMN IF NOT EXISTS "acceptedAt"                 TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "acceptedBy"                 UUID,
  ADD COLUMN IF NOT EXISTS "returnedAt"                 TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "returnCount"                INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "returnReasonCode"           "HandoffReturnReason",
  ADD COLUMN IF NOT EXISTS "returnReasonNote"           TEXT,
  ADD COLUMN IF NOT EXISTS "managerReviewRequired"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "autoDropAt"                 TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "handoffPhoneSnapshot"       TEXT,
  ADD COLUMN IF NOT EXISTS "handoffPresetSnapshot"      UUID,
  ADD COLUMN IF NOT EXISTS "portalEnabledAt"            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "portalPhoneSource"          "PortalPhoneSource" NOT NULL DEFAULT 'LEAD_SNAPSHOT',
  ADD COLUMN IF NOT EXISTS "portalPhoneSnapshot"        TEXT,
  ADD COLUMN IF NOT EXISTS "portalPhoneLast4"           VARCHAR(4),
  ADD COLUMN IF NOT EXISTS "lastClientVisiblePublishAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastInternalChangeAt"       TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "DocCase_caseNumber_key"      ON "DocCase"("caseNumber");
CREATE INDEX        IF NOT EXISTS "DocCase_tenantId_handoffState_idx" ON "DocCase"("tenantId", "handoffState");
CREATE INDEX        IF NOT EXISTS "DocCase_autoDropAt_idx"      ON "DocCase"("autoDropAt");

-- ─── Client-visible publishing flags ────────────────────────────────────────
ALTER TABLE "DocCaseDocument"
  ADD COLUMN IF NOT EXISTS "clientVisible"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "clientVisibleAt" TIMESTAMP(3);

ALTER TABLE "DocCaseNote"
  ADD COLUMN IF NOT EXISTS "clientVisible"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "clientVisibleAt" TIMESTAMP(3);

-- ─── PortalSession ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PortalSession" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"   UUID         NOT NULL,
  "caseId"     UUID         NOT NULL,
  "tokenHash"  CHAR(64)     NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3),
  "ipAddress"  TEXT,
  "userAgent"  TEXT,
  "revokedAt"  TIMESTAMP(3),
  CONSTRAINT "PortalSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PortalSession_tokenHash_key" ON "PortalSession"("tokenHash");
CREATE INDEX IF NOT EXISTS "PortalSession_caseId_idx"    ON "PortalSession"("caseId");
CREATE INDEX IF NOT EXISTS "PortalSession_tenantId_idx"  ON "PortalSession"("tenantId");
CREATE INDEX IF NOT EXISTS "PortalSession_expiresAt_idx" ON "PortalSession"("expiresAt");

DO $$ BEGIN
  ALTER TABLE "PortalSession"
    ADD CONSTRAINT "PortalSession_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "DocCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── PortalAuthAttempt ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PortalAuthAttempt" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID,
  "caseId"      UUID,
  "caseNumber"  TEXT         NOT NULL,
  "ipAddress"   TEXT         NOT NULL,
  "succeeded"   BOOLEAN      NOT NULL DEFAULT false,
  "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PortalAuthAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PortalAuthAttempt_lookup_idx"
  ON "PortalAuthAttempt"("caseNumber", "ipAddress", "attemptedAt");
CREATE INDEX IF NOT EXISTS "PortalAuthAttempt_attemptedAt_idx"
  ON "PortalAuthAttempt"("attemptedAt");

DO $$ BEGIN
  ALTER TABLE "PortalAuthAttempt"
    ADD CONSTRAINT "PortalAuthAttempt_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "DocCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── PortalContactChangeRequest ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PortalContactChangeRequest" (
  "id"          UUID                        NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID                        NOT NULL,
  "caseId"      UUID                        NOT NULL,
  "newPhone"    TEXT                        NOT NULL,
  "reason"      TEXT                        NOT NULL,
  "status"      "PortalContactChangeStatus" NOT NULL DEFAULT 'PENDING',
  "requestedBy" UUID                        NOT NULL,
  "approvedBy"  UUID,
  "createdAt"   TIMESTAMP(3)                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"  TIMESTAMP(3),
  CONSTRAINT "PortalContactChangeRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PortalContactChangeRequest_caseId_idx"
  ON "PortalContactChangeRequest"("caseId");
CREATE INDEX IF NOT EXISTS "PortalContactChangeRequest_tenantId_status_idx"
  ON "PortalContactChangeRequest"("tenantId", "status");

DO $$ BEGIN
  ALTER TABLE "PortalContactChangeRequest"
    ADD CONSTRAINT "PortalContactChangeRequest_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "DocCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
