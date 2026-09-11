-- CreateEnum
CREATE TYPE "MandateRequestStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED', 'VERIFIED', 'REJECTED', 'EXPIRED', 'SUPERSEDED');

-- AlterEnum (DocEventType — mandate lifecycle events)
ALTER TYPE "DocEventType" ADD VALUE 'MANDATE_SENT';
ALTER TYPE "DocEventType" ADD VALUE 'MANDATE_UPLOADED';
ALTER TYPE "DocEventType" ADD VALUE 'MANDATE_VERIFIED';
ALTER TYPE "DocEventType" ADD VALUE 'MANDATE_REJECTED';
ALTER TYPE "DocEventType" ADD VALUE 'MANDATE_LINK_REGENERATED';
ALTER TYPE "DocEventType" ADD VALUE 'MANDATE_SUPERSEDED';
ALTER TYPE "DocEventType" ADD VALUE 'MANDATE_EXPIRED_BATCH';

-- AlterEnum (NotificationType — mandate notification)
ALTER TYPE "NotificationType" ADD VALUE 'MANDATE_UPLOAD_RECEIVED';

-- CreateTable
CREATE TABLE "MandateRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "mandateType" TEXT NOT NULL,
    "description" TEXT,
    "status" "MandateRequestStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "uploadTokenHash" CHAR(64) NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "maxFileSizeBytes" INTEGER NOT NULL DEFAULT 5242880,
    "allowedTypes" TEXT[] DEFAULT ARRAY['application/pdf', 'image/jpeg', 'image/png'],
    "sentToEmail" TEXT,
    "sentToPhone" TEXT,
    "sentByUserId" UUID NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" UUID,
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" UUID,
    "rejectionReason" TEXT,
    "supersededBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MandateRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MandateUpload" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "mandateRequestId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadIp" TEXT,
    "uploadUserAgent" TEXT,

    CONSTRAINT "MandateUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MandateRequest_uploadTokenHash_key" ON "MandateRequest"("uploadTokenHash");

-- CreateIndex
CREATE INDEX "MandateRequest_tenantId_idx" ON "MandateRequest"("tenantId");

-- CreateIndex
CREATE INDEX "MandateRequest_caseId_idx" ON "MandateRequest"("caseId");

-- CreateIndex
CREATE INDEX "MandateRequest_uploadTokenHash_idx" ON "MandateRequest"("uploadTokenHash");

-- CreateIndex
CREATE INDEX "MandateRequest_tokenExpiresAt_idx" ON "MandateRequest"("tokenExpiresAt");

-- CreateIndex
CREATE INDEX "MandateRequest_tenantId_status_idx" ON "MandateRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "MandateUpload_mandateRequestId_idx" ON "MandateUpload"("mandateRequestId");

-- CreateIndex
CREATE INDEX "MandateUpload_tenantId_idx" ON "MandateUpload"("tenantId");

-- AddForeignKey
ALTER TABLE "MandateRequest" ADD CONSTRAINT "MandateRequest_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "DocCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MandateUpload" ADD CONSTRAINT "MandateUpload_mandateRequestId_fkey" FOREIGN KEY ("mandateRequestId") REFERENCES "MandateRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;