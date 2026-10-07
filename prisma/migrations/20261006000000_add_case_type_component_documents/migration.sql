-- AlterTable
ALTER TABLE "DocCaseDocument" ADD COLUMN     "isComponentMerged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requirementDedupeKey" TEXT;

-- AlterTable
ALTER TABLE "DocCasePolicyComponent" ADD COLUMN     "documentsMaterializedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CaseTypeComponentDocument" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseTypeId" UUID NOT NULL,
    "componentId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "description" TEXT,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CaseTypeComponentDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocCaseDocumentComponentSource" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "policyAssignmentId" UUID NOT NULL,
    "policyComponentId" UUID NOT NULL,
    "componentId" UUID NOT NULL,
    "componentDocumentId" UUID,
    "isMandatoryAtLink" BOOLEAN NOT NULL DEFAULT false,
    "displayOrderAtLink" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocCaseDocumentComponentSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseTypeComponentDocument_tenantId_componentId_isActive_idx" ON "CaseTypeComponentDocument"("tenantId", "componentId", "isActive");

-- CreateIndex
CREATE INDEX "CaseTypeComponentDocument_tenantId_caseTypeId_idx" ON "CaseTypeComponentDocument"("tenantId", "caseTypeId");

-- CreateIndex
CREATE INDEX "CaseTypeComponentDocument_deletedAt_idx" ON "CaseTypeComponentDocument"("deletedAt");

-- CreateIndex
CREATE INDEX "DocCaseDocumentComponentSource_tenantId_caseId_idx" ON "DocCaseDocumentComponentSource"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "DocCaseDocumentComponentSource_tenantId_documentId_idx" ON "DocCaseDocumentComponentSource"("tenantId", "documentId");

-- CreateIndex
CREATE INDEX "DocCaseDocumentComponentSource_tenantId_policyComponentId_idx" ON "DocCaseDocumentComponentSource"("tenantId", "policyComponentId");

-- CreateIndex
CREATE INDEX "DocCaseDocumentComponentSource_tenantId_policyAssignmentId_idx" ON "DocCaseDocumentComponentSource"("tenantId", "policyAssignmentId");

-- CreateIndex
CREATE INDEX "DocCaseDocumentComponentSource_deletedAt_idx" ON "DocCaseDocumentComponentSource"("deletedAt");

-- CreateIndex
CREATE INDEX "DocCaseDocument_tenantId_caseId_requirementDedupeKey_idx" ON "DocCaseDocument"("tenantId", "caseId", "requirementDedupeKey");


-- AddForeignKey
ALTER TABLE "CaseTypeComponentDocument" ADD CONSTRAINT "CaseTypeComponentDocument_caseTypeId_fkey" FOREIGN KEY ("caseTypeId") REFERENCES "CaseType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseTypeComponentDocument" ADD CONSTRAINT "CaseTypeComponentDocument_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "CaseTypeComponent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCaseDocumentComponentSource" ADD CONSTRAINT "DocCaseDocumentComponentSource_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "DocCaseDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCaseDocumentComponentSource" ADD CONSTRAINT "DocCaseDocumentComponentSource_policyAssignmentId_fkey" FOREIGN KEY ("policyAssignmentId") REFERENCES "DocCasePolicyAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCaseDocumentComponentSource" ADD CONSTRAINT "DocCaseDocumentComponentSource_policyComponentId_fkey" FOREIGN KEY ("policyComponentId") REFERENCES "DocCasePolicyComponent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCaseDocumentComponentSource" ADD CONSTRAINT "DocCaseDocumentComponentSource_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "CaseTypeComponent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocCaseDocumentComponentSource" ADD CONSTRAINT "DocCaseDocumentComponentSource_componentDocumentId_fkey" FOREIGN KEY ("componentDocumentId") REFERENCES "CaseTypeComponentDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Backfill A: freeze existing component selections ───────────────────────────
-- Existing selections were materialized under the OLD rule (a component itself
-- created one document). Stamping documentsMaterializedAt stops them from
-- re-materializing (and double-generating) under the new preset-driven rule on
-- their next save. Idempotent via the IS NULL guard.
UPDATE "DocCasePolicyComponent" SET "documentsMaterializedAt" = now()
WHERE "deletedAt" IS NULL AND "documentsMaterializedAt" IS NULL;

-- ─── Backfill B: mark legacy component-generated documents ──────────────────────
-- Keyed as legacy:<policyComponentId> so they never collide with, or merge into,
-- the new compdoc:<dedupeKey> shared requirements. isComponentMerged stays false.
UPDATE "DocCaseDocument" SET "requirementDedupeKey" = 'legacy:' || "policyComponentId", "isComponentMerged" = false
WHERE "policyComponentId" IS NOT NULL AND "requirementDedupeKey" IS NULL AND "deletedAt" IS NULL;

-- ─── Backfill C: source rows for legacy documents ───────────────────────────────
-- Tenant-matched join, and only for still-active selections: creating an ACTIVE
-- source row for an already-deselected selection would make its document
-- permanently un-cleanable and wrongly mandatory. Idempotent via NOT EXISTS.
INSERT INTO "DocCaseDocumentComponentSource" (id,"tenantId","caseId","documentId","policyAssignmentId","policyComponentId","componentId","componentDocumentId","isMandatoryAtLink","displayOrderAtLink","createdAt","updatedAt")
SELECT gen_random_uuid(), d."tenantId", d."caseId", d.id, pc."policyAssignmentId", pc.id, pc."componentId", NULL, d."isMandatory", d."displayOrder", now(), now()
FROM "DocCaseDocument" d
JOIN "DocCasePolicyComponent" pc
  ON pc.id = d."policyComponentId" AND pc."tenantId" = d."tenantId" AND pc."deletedAt" IS NULL
WHERE d."policyComponentId" IS NOT NULL
  AND d."requirementDedupeKey" LIKE 'legacy:%'
  AND d."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "DocCaseDocumentComponentSource" s
    WHERE s."documentId" = d.id AND s."tenantId" = d."tenantId" AND s."deletedAt" IS NULL
  );
