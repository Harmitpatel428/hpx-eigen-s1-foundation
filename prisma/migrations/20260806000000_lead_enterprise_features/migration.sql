-- ============================================================================
-- Migration: Lead Enterprise Features
-- Adds: priority, expectedCloseDate, location, tags (LeadTag + LeadTagAssignment)
-- ============================================================================

-- CreateEnum
CREATE TYPE "LeadPriority" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- AlterTable Lead — add new columns
ALTER TABLE "Lead"
  ADD COLUMN "priority"          "LeadPriority" NOT NULL DEFAULT 'MEDIUM',
  ADD COLUMN "expectedCloseDate" TIMESTAMP(3),
  ADD COLUMN "country"           TEXT,
  ADD COLUMN "state"             TEXT,
  ADD COLUMN "city"              TEXT,
  ADD COLUMN "area"              TEXT,
  ADD COLUMN "postalCode"        TEXT;

-- CreateTable LeadTag
CREATE TABLE "LeadTag" (
    "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenantId"   UUID         NOT NULL,
    "name"       TEXT         NOT NULL,
    "color"      TEXT         DEFAULT '#6366f1',
    "usageCount" INTEGER      NOT NULL DEFAULT 0,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    "deletedAt"  TIMESTAMP(3),

    CONSTRAINT "LeadTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable LeadTagAssignment
CREATE TABLE "LeadTagAssignment" (
    "leadId" UUID NOT NULL,
    "tagId"  UUID NOT NULL,

    CONSTRAINT "LeadTagAssignment_pkey" PRIMARY KEY ("leadId", "tagId")
);

-- CreateUniqueIndex (tenantId, name) on LeadTag
CREATE UNIQUE INDEX "LeadTag_tenantId_name_key" ON "LeadTag"("tenantId", "name");

-- CreateIndex on LeadTag
CREATE INDEX "LeadTag_tenantId_idx"  ON "LeadTag"("tenantId");
CREATE INDEX "LeadTag_deletedAt_idx" ON "LeadTag"("deletedAt");

-- CreateIndex on Lead new columns
CREATE INDEX "Lead_tenantId_priority_idx" ON "Lead"("tenantId", "priority");

-- CreateIndex on LeadTagAssignment
CREATE INDEX "LeadTagAssignment_leadId_idx" ON "LeadTagAssignment"("leadId");
CREATE INDEX "LeadTagAssignment_tagId_idx"  ON "LeadTagAssignment"("tagId");

-- AddForeignKey LeadTagAssignment → Lead
ALTER TABLE "LeadTagAssignment" ADD CONSTRAINT "LeadTagAssignment_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey LeadTagAssignment → LeadTag
ALTER TABLE "LeadTagAssignment" ADD CONSTRAINT "LeadTagAssignment_tagId_fkey"
  FOREIGN KEY ("tagId") REFERENCES "LeadTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
