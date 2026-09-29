-- CreateEnum
CREATE TYPE "CaseTypeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- AlterTable
ALTER TABLE "DocCase" ADD COLUMN     "caseTypeId" UUID;

-- CreateTable
CREATE TABLE "CaseType" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "CaseTypeStatus" NOT NULL DEFAULT 'DRAFT',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CaseType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseTypeFieldPlacement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseTypeId" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseTypeFieldPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseType_tenantId_idx" ON "CaseType"("tenantId");

-- CreateIndex
CREATE INDEX "CaseType_tenantId_status_idx" ON "CaseType"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CaseType_deletedAt_idx" ON "CaseType"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CaseType_tenantId_key_key" ON "CaseType"("tenantId", "key");

-- CreateIndex
CREATE INDEX "CaseTypeFieldPlacement_tenantId_caseTypeId_idx" ON "CaseTypeFieldPlacement"("tenantId", "caseTypeId");

-- CreateIndex
CREATE INDEX "CaseTypeFieldPlacement_tenantId_fieldId_idx" ON "CaseTypeFieldPlacement"("tenantId", "fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseTypeFieldPlacement_tenantId_caseTypeId_fieldId_key" ON "CaseTypeFieldPlacement"("tenantId", "caseTypeId", "fieldId");

-- AddForeignKey
ALTER TABLE "DocCase" ADD CONSTRAINT "DocCase_caseTypeId_fkey" FOREIGN KEY ("caseTypeId") REFERENCES "CaseType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseTypeFieldPlacement" ADD CONSTRAINT "CaseTypeFieldPlacement_caseTypeId_fkey" FOREIGN KEY ("caseTypeId") REFERENCES "CaseType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseTypeFieldPlacement" ADD CONSTRAINT "CaseTypeFieldPlacement_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "CaseFieldDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

