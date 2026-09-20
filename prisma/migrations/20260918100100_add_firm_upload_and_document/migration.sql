-- Firm direct upload (Phase 1): unified Document table + firm-upload metadata on
-- MandateUpload. Additive only — no DROP/DELETE/UPDATE. New enum types are created
-- here (CREATE TYPE), so they may be used as column defaults in the same migration.
-- SAFETY-REVIEWED: additive-only (CREATE TYPE/TABLE/INDEX, ADD COLUMN, ADD CONSTRAINT).
-- The guard's "mass UPDATE" hit is a false positive on the "ON DELETE SET NULL
-- ON UPDATE CASCADE" foreign-key clauses (standard Prisma syntax); no rows are mutated.

-- CreateEnum
CREATE TYPE "UploadedByParty" AS ENUM ('CLIENT', 'FIRM', 'SYSTEM');
CREATE TYPE "DocumentSourceChannel" AS ENUM ('CLIENT_PORTAL', 'WHATSAPP', 'EMAIL', 'PHYSICAL', 'FIRM_UPLOAD', 'OTHER');
CREATE TYPE "DocumentCategory" AS ENUM ('MANDATE', 'REQUIREMENT', 'GENERAL', 'CUSTOM_GROUP_DOCUMENT', 'CUSTOM_FIELD_DOCUMENT');
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADING', 'SCANNING', 'RECEIVED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED', 'ARCHIVED', 'MALWARE_DETECTED');

-- AlterTable: firm-upload metadata on MandateUpload. Defaults cover existing rows
-- (all prior uploads are client-portal), so no backfill UPDATE is required.
ALTER TABLE "MandateUpload"
  ADD COLUMN "uploadId" UUID,
  ADD COLUMN "uploadedByParty" "UploadedByParty" NOT NULL DEFAULT 'CLIENT',
  ADD COLUMN "sourceChannel" "DocumentSourceChannel" NOT NULL DEFAULT 'CLIENT_PORTAL',
  ADD COLUMN "uploadedByUserId" UUID,
  ADD COLUMN "internalNote" TEXT,
  ADD COLUMN "expiresAt" TIMESTAMP(3);

-- CreateTable: unified Document store
CREATE TABLE "Document" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "caseId" UUID NOT NULL,
  "requirementId" UUID,
  "groupInstanceId" UUID,
  "fieldDefinitionId" UUID,
  "uploadId" UUID,
  "category" "DocumentCategory" NOT NULL,
  "name" TEXT NOT NULL,
  "originalFilename" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "checksum" TEXT,
  "status" "DocumentStatus" NOT NULL DEFAULT 'RECEIVED',
  "sourceChannel" "DocumentSourceChannel" NOT NULL,
  "uploadedByParty" "UploadedByParty" NOT NULL,
  "uploadedByUserId" UUID,
  "internalNote" TEXT,
  "clientVisible" BOOLEAN NOT NULL DEFAULT false,
  "versionOfId" UUID,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt" TIMESTAMP(3),
  "verifiedByUserId" UUID,
  "rejectedAt" TIMESTAMP(3),
  "rejectedByUserId" UUID,
  "rejectionReason" TEXT,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- Unique indexes for idempotent confirm (uploadId capability key)
CREATE UNIQUE INDEX "MandateUpload_uploadId_key" ON "MandateUpload"("uploadId");
CREATE UNIQUE INDEX "Document_uploadId_key" ON "Document"("uploadId");

-- Lookup indexes
CREATE INDEX "Document_tenantId_idx" ON "Document"("tenantId");
CREATE INDEX "Document_caseId_idx" ON "Document"("caseId");
CREATE INDEX "Document_requirementId_idx" ON "Document"("requirementId");
CREATE INDEX "Document_tenantId_category_idx" ON "Document"("tenantId", "category");
CREATE INDEX "Document_caseId_isActive_idx" ON "Document"("caseId", "isActive");

-- At most one ACTIVE, non-deleted REQUIREMENT document per (tenant, requirement).
-- Partial predicate → Prisma cannot express it; raw SQL. Violations map to HTTP 409.
CREATE UNIQUE INDEX "Document_active_requirement_uniq"
  ON "Document"("tenantId", "requirementId")
  WHERE "category" = 'REQUIREMENT' AND "isActive" AND "deletedAt" IS NULL;

-- Foreign keys
ALTER TABLE "Document" ADD CONSTRAINT "Document_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "DocCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_requirementId_fkey"
  FOREIGN KEY ("requirementId") REFERENCES "DocCaseDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_versionOfId_fkey"
  FOREIGN KEY ("versionOfId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
