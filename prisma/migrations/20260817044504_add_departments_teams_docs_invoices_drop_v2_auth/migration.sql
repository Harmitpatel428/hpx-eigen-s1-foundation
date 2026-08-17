/*
  Warnings:

  - You are about to drop the column `description` on the `Role` table. All the data in the column will be lost.
  - You are about to drop the column `identityId` on the `Session` table. All the data in the column will be lost.
  - You are about to drop the column `v2IdentityId` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `v2MembershipId` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `v2MigrationStatus` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `identityId` on the `VerificationToken` table. All the data in the column will be lost.
  - You are about to drop the `Assignment` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Identity` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `MembershipRole` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `OrganizationMembership` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `OutboxEvent` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PermissionOverride` table. If the table is not empty, all the data it contains will be lost.
  - Made the column `description` on table `Permission` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CREDIT_CARD', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'NEFT', 'RTGS', 'IMPS', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'RECEIVED', 'FAILED', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocPresetCategory" AS ENUM ('GOVERNMENT', 'FINANCIAL', 'LEGAL', 'OPERATIONAL', 'COMPLIANCE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "DocDocumentStatus" AS ENUM ('REQUESTED', 'PENDING_COLLECTION', 'RECEIVED', 'UNDER_VERIFICATION', 'APPROVED', 'REJECTED', 'RE_REQUESTED', 'EXPIRED', 'NOT_APPLICABLE', 'WAIVED', 'MANAGER_APPROVED');

-- CreateEnum
CREATE TYPE "DocCaseStatus" AS ENUM ('ACTIVE', 'DOCUMENTATION_READY', 'TRANSFERRED_TO_PROCESS', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocNoteType" AS ENUM ('INTERNAL', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "DocStorageType" AS ENUM ('GOOGLE_DRIVE', 'ONEDRIVE', 'DROPBOX', 'SHAREPOINT', 'NAS_PATH', 'LOCAL_FOLDER', 'PHYSICAL_CABINET', 'REFERENCE_NUMBER', 'EMAIL', 'EXTERNAL_PORTAL', 'STORED_OFFLINE', 'OTHER');

-- CreateEnum
CREATE TYPE "DocEventType" AS ENUM ('CASE_CREATED', 'PRESET_APPLIED', 'DOCUMENT_STATUS_CHANGED', 'DOCUMENT_RECEIVED', 'DOCUMENT_VERIFIED', 'DOCUMENT_REJECTED', 'DOCUMENT_WAIVED', 'DOCUMENT_APPROVED', 'REMINDER_SENT', 'NOTE_ADDED', 'STORAGE_REF_ADDED', 'MANAGER_OVERRIDE', 'TRANSFERRED_TO_PROCESS', 'CASE_CLOSED', 'CASE_CANCELLED', 'EXPIRY_WARNING');

-- DropForeignKey
ALTER TABLE "Assignment" DROP CONSTRAINT "Assignment_membershipId_fkey";

-- DropForeignKey
ALTER TABLE "MembershipRole" DROP CONSTRAINT "MembershipRole_membershipId_fkey";

-- DropForeignKey
ALTER TABLE "MembershipRole" DROP CONSTRAINT "MembershipRole_roleId_fkey";

-- DropForeignKey
ALTER TABLE "OrganizationMembership" DROP CONSTRAINT "OrganizationMembership_identityId_fkey";

-- DropForeignKey
ALTER TABLE "OrganizationMembership" DROP CONSTRAINT "OrganizationMembership_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "OutboxEvent" DROP CONSTRAINT "OutboxEvent_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "PermissionOverride" DROP CONSTRAINT "PermissionOverride_membershipId_fkey";

-- DropForeignKey
ALTER TABLE "Role" DROP CONSTRAINT "Role_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT "Session_identityId_fkey";

-- DropForeignKey
ALTER TABLE "VerificationToken" DROP CONSTRAINT "VerificationToken_identityId_fkey";

-- DropIndex
DROP INDEX "RolePermission_permissionId_idx";

-- DropIndex
DROP INDEX "RolePermission_roleId_idx";

-- DropIndex
DROP INDEX "Session_identityId_idx";

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "isMain" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ownerId" UUID,
ADD COLUMN     "role" TEXT;

-- AlterTable
ALTER TABLE "LeadActivity" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "LeadNote" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "LeadTag" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "customOpportunityType" TEXT,
ADD COLUMN     "opportunityTypeId" UUID;

-- AlterTable
ALTER TABLE "Permission" ALTER COLUMN "description" SET NOT NULL;

-- AlterTable
ALTER TABLE "Role" DROP COLUMN "description",
ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Session" DROP COLUMN "identityId";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "v2IdentityId",
DROP COLUMN "v2MembershipId",
DROP COLUMN "v2MigrationStatus",
ADD COLUMN     "departmentId" UUID,
ADD COLUMN     "emailVerified" TIMESTAMP(3),
ADD COLUMN     "teamId" UUID,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "VerificationToken" DROP COLUMN "identityId";

-- DropTable
DROP TABLE "Assignment";

-- DropTable
DROP TABLE "Identity";

-- DropTable
DROP TABLE "MembershipRole";

-- DropTable
DROP TABLE "OrganizationMembership";

-- DropTable
DROP TABLE "OutboxEvent";

-- DropTable
DROP TABLE "PermissionOverride";

-- DropEnum
DROP TYPE "AssignmentType";

-- DropEnum
DROP TYPE "DomainEventStatus";

-- DropEnum
DROP TYPE "IdentityStatus";

-- DropEnum
DROP TYPE "MembershipStatus";

-- DropEnum
DROP TYPE "OverrideType";

-- CreateTable
CREATE TABLE "Department" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "departmentId" UUID,
    "name" TEXT NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadFieldDef" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadFieldDef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityType" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "OpportunityType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "opportunityId" UUID NOT NULL,
    "invoiceNumber" TEXT,
    "invoiceDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" DECIMAL(18,2) NOT NULL,
    "taxPercentage" DECIMAL(5,2) DEFAULT 0,
    "discount" DECIMAL(18,2) DEFAULT 0,
    "otherCharges" DECIMAL(18,2) DEFAULT 0,
    "taxAmount" DECIMAL(18,2) DEFAULT 0,
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "paymentTerms" TEXT,
    "internalNotes" TEXT,
    "invoiceNotes" TEXT,
    "termsConditions" TEXT,
    "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "dueDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "referenceNumber" TEXT,
    "bankName" TEXT,
    "chequeNumber" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "receivedBy" TEXT,
    "notes" TEXT,
    "attachmentUrl" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocPreset" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "DocPresetCategory" NOT NULL DEFAULT 'CUSTOM',
    "color" TEXT,
    "icon" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" UUID NOT NULL,
    "updatedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocPresetItem" (
    "id" UUID NOT NULL,
    "presetId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "isBlocking" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "verificationRequired" BOOLEAN NOT NULL DEFAULT true,
    "expiryTrackingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "expiryDays" INTEGER,
    "metadataFields" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "conditionRule" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocPresetItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocPresetVersion" (
    "id" UUID NOT NULL,
    "presetId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedBy" UUID NOT NULL,
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocPresetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocCase" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "presetId" UUID,
    "presetVersion" INTEGER,
    "assignedTo" UUID,
    "status" "DocCaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "totalDocs" INTEGER NOT NULL DEFAULT 0,
    "receivedDocs" INTEGER NOT NULL DEFAULT 0,
    "verifiedDocs" INTEGER NOT NULL DEFAULT 0,
    "approvedDocs" INTEGER NOT NULL DEFAULT 0,
    "rejectedDocs" INTEGER NOT NULL DEFAULT 0,
    "mandatoryDocs" INTEGER NOT NULL DEFAULT 0,
    "mandatoryApproved" INTEGER NOT NULL DEFAULT 0,
    "completionPercent" INTEGER NOT NULL DEFAULT 0,
    "isReady" BOOLEAN NOT NULL DEFAULT false,
    "dueDate" TIMESTAMP(3),
    "transferredAt" TIMESTAMP(3),
    "transferredBy" UUID,
    "closedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocCaseDocument" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "presetItemId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "isBlocking" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "verificationRequired" BOOLEAN NOT NULL DEFAULT true,
    "expiryTrackingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "expiryDate" TIMESTAMP(3),
    "status" "DocDocumentStatus" NOT NULL DEFAULT 'REQUESTED',
    "receivedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" UUID,
    "verificationRemarks" TEXT,
    "rejectionReason" TEXT,
    "isWaived" BOOLEAN NOT NULL DEFAULT false,
    "waivedBy" UUID,
    "waivedReason" TEXT,
    "metadataValues" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocCaseDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocCaseEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "documentId" UUID,
    "eventType" "DocEventType" NOT NULL,
    "actorUserId" UUID,
    "actorDepartment" TEXT,
    "fromStatus" "DocDocumentStatus",
    "toStatus" "DocDocumentStatus",
    "remarks" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocCaseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocCaseNote" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "noteType" "DocNoteType" NOT NULL DEFAULT 'INTERNAL',
    "content" TEXT NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocCaseNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocStorageRef" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "storageType" "DocStorageType" NOT NULL,
    "reference" TEXT NOT NULL,
    "label" TEXT,
    "addedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocStorageRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocReminder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "documentId" UUID,
    "reminderDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "isTriggered" BOOLEAN NOT NULL DEFAULT false,
    "triggeredAt" TIMESTAMP(3),
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocManagerOverride" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "overriddenBy" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "allowedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "DocManagerOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Department_tenantId_idx" ON "Department"("tenantId");

-- CreateIndex
CREATE INDEX "Team_tenantId_departmentId_idx" ON "Team"("tenantId", "departmentId");

-- CreateIndex
CREATE INDEX "LeadFieldDef_tenantId_idx" ON "LeadFieldDef"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadFieldDef_tenantId_key_key" ON "LeadFieldDef"("tenantId", "key");

-- CreateIndex
CREATE INDEX "OpportunityType_tenantId_idx" ON "OpportunityType"("tenantId");

-- CreateIndex
CREATE INDEX "OpportunityType_deletedAt_idx" ON "OpportunityType"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityType_tenantId_name_key" ON "OpportunityType"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_idx" ON "Invoice"("tenantId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_opportunityId_idx" ON "Invoice"("tenantId", "opportunityId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_status_idx" ON "Invoice"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Invoice_deletedAt_idx" ON "Invoice"("deletedAt");

-- CreateIndex
CREATE INDEX "Payment_tenantId_idx" ON "Payment"("tenantId");

-- CreateIndex
CREATE INDEX "Payment_tenantId_invoiceId_idx" ON "Payment"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "Payment_deletedAt_idx" ON "Payment"("deletedAt");

-- CreateIndex
CREATE INDEX "DocPreset_tenantId_idx" ON "DocPreset"("tenantId");

-- CreateIndex
CREATE INDEX "DocPreset_tenantId_isActive_idx" ON "DocPreset"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "DocPreset_deletedAt_idx" ON "DocPreset"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocPreset_tenantId_name_key" ON "DocPreset"("tenantId", "name");

-- CreateIndex
CREATE INDEX "DocPresetItem_presetId_idx" ON "DocPresetItem"("presetId");

-- CreateIndex
CREATE INDEX "DocPresetItem_tenantId_idx" ON "DocPresetItem"("tenantId");

-- CreateIndex
CREATE INDEX "DocPresetItem_deletedAt_idx" ON "DocPresetItem"("deletedAt");

-- CreateIndex
CREATE INDEX "DocPresetVersion_tenantId_idx" ON "DocPresetVersion"("tenantId");

-- CreateIndex
CREATE INDEX "DocPresetVersion_presetId_createdAt_idx" ON "DocPresetVersion"("presetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocPresetVersion_presetId_version_key" ON "DocPresetVersion"("presetId", "version");

-- CreateIndex
CREATE INDEX "DocCase_tenantId_idx" ON "DocCase"("tenantId");

-- CreateIndex
CREATE INDEX "DocCase_tenantId_status_idx" ON "DocCase"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DocCase_tenantId_assignedTo_idx" ON "DocCase"("tenantId", "assignedTo");

-- CreateIndex
CREATE INDEX "DocCase_tenantId_isReady_idx" ON "DocCase"("tenantId", "isReady");

-- CreateIndex
CREATE INDEX "DocCase_deletedAt_idx" ON "DocCase"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocCase_tenantId_leadId_key" ON "DocCase"("tenantId", "leadId");

-- CreateIndex
CREATE INDEX "DocCaseDocument_caseId_idx" ON "DocCaseDocument"("caseId");

-- CreateIndex
CREATE INDEX "DocCaseDocument_tenantId_idx" ON "DocCaseDocument"("tenantId");

-- CreateIndex
CREATE INDEX "DocCaseDocument_tenantId_status_idx" ON "DocCaseDocument"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DocCaseDocument_deletedAt_idx" ON "DocCaseDocument"("deletedAt");

-- CreateIndex
CREATE INDEX "DocCaseEvent_caseId_createdAt_idx" ON "DocCaseEvent"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "DocCaseEvent_tenantId_idx" ON "DocCaseEvent"("tenantId");

-- CreateIndex
CREATE INDEX "DocCaseNote_caseId_idx" ON "DocCaseNote"("caseId");

-- CreateIndex
CREATE INDEX "DocCaseNote_tenantId_idx" ON "DocCaseNote"("tenantId");

-- CreateIndex
CREATE INDEX "DocStorageRef_documentId_idx" ON "DocStorageRef"("documentId");

-- CreateIndex
CREATE INDEX "DocStorageRef_tenantId_idx" ON "DocStorageRef"("tenantId");

-- CreateIndex
CREATE INDEX "DocReminder_caseId_idx" ON "DocReminder"("caseId");

-- CreateIndex
CREATE INDEX "DocReminder_tenantId_reminderDate_idx" ON "DocReminder"("tenantId", "reminderDate");

-- CreateIndex
CREATE INDEX "DocManagerOverride_caseId_idx" ON "DocManagerOverride"("caseId");

-- CreateIndex
CREATE INDEX "DocManagerOverride_tenantId_idx" ON "DocManagerOverride"("tenantId");

-- CreateIndex
CREATE INDEX "Contact_tenantId_ownerId_idx" ON "Contact"("tenantId", "ownerId");

-- CreateIndex
CREATE INDEX "Opportunity_tenantId_opportunityTypeId_idx" ON "Opportunity"("tenantId", "opportunityTypeId");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_teamId_deletedAt_idx" ON "User"("teamId", "deletedAt");

-- CreateIndex
CREATE INDEX "User_departmentId_deletedAt_idx" ON "User"("departmentId", "deletedAt");

-- CreateIndex
CREATE INDEX "User_tenantId_deletedAt_idx" ON "User"("tenantId", "deletedAt");

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityType" ADD CONSTRAINT "OpportunityType_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_opportunityTypeId_fkey" FOREIGN KEY ("opportunityTypeId") REFERENCES "OpportunityType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocPreset" ADD CONSTRAINT "DocPreset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocPresetItem" ADD CONSTRAINT "DocPresetItem_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "DocPreset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocPresetVersion" ADD CONSTRAINT "DocPresetVersion_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "DocPreset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCase" ADD CONSTRAINT "DocCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCase" ADD CONSTRAINT "DocCase_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCase" ADD CONSTRAINT "DocCase_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "DocPreset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCaseDocument" ADD CONSTRAINT "DocCaseDocument_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "DocCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCaseEvent" ADD CONSTRAINT "DocCaseEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "DocCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCaseEvent" ADD CONSTRAINT "DocCaseEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "DocCaseDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCaseNote" ADD CONSTRAINT "DocCaseNote_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "DocCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocStorageRef" ADD CONSTRAINT "DocStorageRef_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "DocCaseDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocReminder" ADD CONSTRAINT "DocReminder_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "DocCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocManagerOverride" ADD CONSTRAINT "DocManagerOverride_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "DocCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
