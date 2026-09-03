-- LeadPhone history model: normalized phone storage + dedup index.
-- Additive only — no column drops or renames.

-- ─── New enums ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "LeadPhoneStatus" AS ENUM ('ACTIVE', 'INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "LeadPhoneSource" AS ENUM ('IMPORT', 'MANUAL', 'API', 'BACKFILL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── LeadPhone table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "LeadPhone" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenantId"        UUID         NOT NULL,
    "leadId"          UUID         NOT NULL,
    "phoneOriginal"   TEXT         NOT NULL,
    "phoneNormalized" TEXT,
    "status"          "LeadPhoneStatus" NOT NULL DEFAULT 'ACTIVE',
    "isPrimary"       BOOLEAN      NOT NULL DEFAULT false,
    "source"          "LeadPhoneSource" NOT NULL DEFAULT 'MANUAL',
    "deactivatedAt"   TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadPhone_pkey" PRIMARY KEY ("id")
);

-- FK
ALTER TABLE "LeadPhone"
  ADD CONSTRAINT "LeadPhone_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique per (lead, normalized) — null normalized values are excluded
CREATE UNIQUE INDEX IF NOT EXISTS "LeadPhone_leadId_phoneNormalized_key"
  ON "LeadPhone" ("leadId", "phoneNormalized")
  WHERE "phoneNormalized" IS NOT NULL;

-- Search index: normalized phone + tenant for cross-lead lookups
CREATE INDEX IF NOT EXISTS "LeadPhone_phoneNormalized_tenantId_idx"
  ON "LeadPhone" ("phoneNormalized", "tenantId")
  WHERE "phoneNormalized" IS NOT NULL;

-- Per-lead active phones
CREATE INDEX IF NOT EXISTS "LeadPhone_leadId_status_idx"
  ON "LeadPhone" ("leadId", "status");

-- Tenant scoping
CREATE INDEX IF NOT EXISTS "LeadPhone_tenantId_idx"
  ON "LeadPhone" ("tenantId");
