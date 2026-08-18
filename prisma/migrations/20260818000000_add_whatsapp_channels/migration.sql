-- Phase B: WhatsApp Channel data model
-- Adds WhatsAppChannel + LeadWhatsAppChannel tables and seeds from existing Lead.phone values.
-- Lead.phone is intentionally kept for backward compatibility (Phase C will update the WA button to prefer channels).

-- ── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE "WhatsAppChannelType" AS ENUM (
  'INDIVIDUAL_NUMBER',
  'GROUP',
  'USERNAME',
  'BUSINESS_ACCOUNT'
);

CREATE TYPE "WhatsAppChannelStatus" AS ENUM (
  'ACTIVE',
  'INVALID',
  'ARCHIVED'
);

-- ── WhatsAppChannel ───────────────────────────────────────────────────────────

CREATE TABLE "WhatsAppChannel" (
  "id"          UUID          NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID          NOT NULL,
  "channelType" "WhatsAppChannelType"   NOT NULL DEFAULT 'INDIVIDUAL_NUMBER',
  "identifier"  TEXT          NOT NULL,
  "displayName" TEXT          NOT NULL,
  "status"      "WhatsAppChannelStatus" NOT NULL DEFAULT 'ACTIVE',
  "metadata"    JSONB         NOT NULL DEFAULT '{}',
  "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WhatsAppChannel_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WhatsAppChannel_tenantId_idx"        ON "WhatsAppChannel"("tenantId");
CREATE INDEX "WhatsAppChannel_tenantId_status_idx" ON "WhatsAppChannel"("tenantId", "status");

-- ── LeadWhatsAppChannel ───────────────────────────────────────────────────────

CREATE TABLE "LeadWhatsAppChannel" (
  "leadId"    UUID    NOT NULL,
  "channelId" UUID    NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "role"      TEXT    NOT NULL DEFAULT 'primary',
  "label"     TEXT,

  CONSTRAINT "LeadWhatsAppChannel_pkey" PRIMARY KEY ("leadId", "channelId")
);

CREATE INDEX "LeadWhatsAppChannel_leadId_idx"    ON "LeadWhatsAppChannel"("leadId");
CREATE INDEX "LeadWhatsAppChannel_channelId_idx" ON "LeadWhatsAppChannel"("channelId");

ALTER TABLE "LeadWhatsAppChannel"
  ADD CONSTRAINT "LeadWhatsAppChannel_leadId_fkey"
    FOREIGN KEY ("leadId")    REFERENCES "Lead"("id")            ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeadWhatsAppChannel"
  ADD CONSTRAINT "LeadWhatsAppChannel_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "WhatsAppChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Seed: migrate existing Lead.phone → WhatsAppChannel ──────────────────────
-- One channel per active lead that has a phone; marked isPrimary=true.
-- Leads without a phone get no channel (they can add one via the UI in Phase C).

WITH inserted AS (
  INSERT INTO "WhatsAppChannel" (
    "id", "tenantId", "channelType", "identifier", "displayName",
    "status", "metadata", "createdAt", "updatedAt"
  )
  SELECT
    gen_random_uuid(),
    l."tenantId",
    'INDIVIDUAL_NUMBER',
    l."phone",
    COALESCE(NULLIF(TRIM(l."firstName" || ' ' || l."lastName"), ''), l."phone"),
    'ACTIVE',
    '{}',
    NOW(),
    NOW()
  FROM "Lead" l
  WHERE l."phone" IS NOT NULL
    AND l."deletedAt" IS NULL
  RETURNING "id", "tenantId", "identifier"
)
INSERT INTO "LeadWhatsAppChannel" ("leadId", "channelId", "isPrimary", "role", "label")
SELECT
  l."id",
  ins."id",
  true,
  'primary',
  NULL
FROM "Lead" l
JOIN inserted ins
  ON ins."tenantId" = l."tenantId"
  AND ins."identifier" = l."phone"
WHERE l."phone" IS NOT NULL
  AND l."deletedAt" IS NULL;
