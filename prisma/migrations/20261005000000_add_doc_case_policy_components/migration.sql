-- SAFETY-REVIEWED: additive-only migration. The destructive-migration guard's
-- naive regex (UPDATE + SET + no WHERE) matches the standard Prisma foreign-key
-- clauses "ON DELETE SET NULL ON UPDATE CASCADE" below. This migration contains
-- NO data UPDATE/DELETE/DROP/TRUNCATE — only additive CREATE TABLE / ADD COLUMN /
-- CREATE INDEX / ADD CONSTRAINT and one idempotent NOT EXISTS backfill INSERT.

-- AlterTable
ALTER TABLE "DocCaseDocument" ADD COLUMN     "policyAssignmentId" UUID,
ADD COLUMN     "policyComponentId" UUID;

-- CreateTable
CREATE TABLE "CaseTypeComponent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseTypeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CaseTypeComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocCasePolicyAssignment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "caseTypeId" UUID NOT NULL,
    "proposalDate" DATE,
    "actualDate" DATE,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocCasePolicyAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocCasePolicyComponent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "policyAssignmentId" UUID NOT NULL,
    "componentId" UUID NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocCasePolicyComponent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseTypeComponent_tenantId_caseTypeId_isActive_idx" ON "CaseTypeComponent"("tenantId", "caseTypeId", "isActive");

-- CreateIndex
CREATE INDEX "CaseTypeComponent_deletedAt_idx" ON "CaseTypeComponent"("deletedAt");

-- CreateIndex
CREATE INDEX "DocCasePolicyAssignment_tenantId_caseId_idx" ON "DocCasePolicyAssignment"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "DocCasePolicyAssignment_tenantId_caseTypeId_idx" ON "DocCasePolicyAssignment"("tenantId", "caseTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "DocCasePolicyAssignment_tenantId_caseId_caseTypeId_key" ON "DocCasePolicyAssignment"("tenantId", "caseId", "caseTypeId");

-- CreateIndex
CREATE INDEX "DocCasePolicyComponent_tenantId_caseId_idx" ON "DocCasePolicyComponent"("tenantId", "caseId");

-- CreateIndex
CREATE UNIQUE INDEX "DocCasePolicyComponent_tenantId_policyAssignmentId_componen_key" ON "DocCasePolicyComponent"("tenantId", "policyAssignmentId", "componentId");

-- CreateIndex
CREATE INDEX "DocCaseDocument_tenantId_caseId_policyComponentId_idx" ON "DocCaseDocument"("tenantId", "caseId", "policyComponentId");

-- CreateIndex
CREATE INDEX "DocCaseDocument_tenantId_policyAssignmentId_idx" ON "DocCaseDocument"("tenantId", "policyAssignmentId");


-- AddForeignKey
ALTER TABLE "DocCaseDocument" ADD CONSTRAINT "DocCaseDocument_policyAssignmentId_fkey" FOREIGN KEY ("policyAssignmentId") REFERENCES "DocCasePolicyAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCaseDocument" ADD CONSTRAINT "DocCaseDocument_policyComponentId_fkey" FOREIGN KEY ("policyComponentId") REFERENCES "DocCasePolicyComponent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseTypeComponent" ADD CONSTRAINT "CaseTypeComponent_caseTypeId_fkey" FOREIGN KEY ("caseTypeId") REFERENCES "CaseType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCasePolicyAssignment" ADD CONSTRAINT "DocCasePolicyAssignment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "DocCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCasePolicyAssignment" ADD CONSTRAINT "DocCasePolicyAssignment_caseTypeId_fkey" FOREIGN KEY ("caseTypeId") REFERENCES "CaseType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCasePolicyComponent" ADD CONSTRAINT "DocCasePolicyComponent_policyAssignmentId_fkey" FOREIGN KEY ("policyAssignmentId") REFERENCES "DocCasePolicyAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCasePolicyComponent" ADD CONSTRAINT "DocCasePolicyComponent_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "CaseTypeComponent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill: synthesize one DocCasePolicyAssignment for every existing DocCase that
-- already has a caseTypeId but no matching assignment row. Idempotent (NOT EXISTS),
-- so re-running adds nothing. Explicit id since DB column defaults are not relied on.
INSERT INTO "DocCasePolicyAssignment" ("id", "tenantId", "caseId", "caseTypeId", "proposalDate", "actualDate", "displayOrder", "createdBy", "createdAt", "updatedAt")
SELECT gen_random_uuid(), dc."tenantId", dc."id", dc."caseTypeId", NULL, NULL, 0, NULL, now(), now()
FROM "DocCase" dc
WHERE dc."caseTypeId" IS NOT NULL
  AND dc."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "DocCasePolicyAssignment" pa
    WHERE pa."tenantId" = dc."tenantId"
      AND pa."caseId" = dc."id"
      AND pa."caseTypeId" = dc."caseTypeId"
  );
