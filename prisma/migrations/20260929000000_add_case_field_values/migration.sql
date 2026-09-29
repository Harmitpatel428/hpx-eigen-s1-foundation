-- CreateTable
CREATE TABLE "CaseFieldValue" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "valueText" TEXT,
    "valueNumber" DECIMAL(20,6),
    "valueBoolean" BOOLEAN,
    "valueDate" TIMESTAMP(3),
    "optionId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CaseFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseFieldValueOption" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "valueId" UUID NOT NULL,
    "optionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseFieldValueOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseFieldValueHistory" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "valueId" UUID,
    "operation" VARCHAR(16) NOT NULL,
    "beforeValue" JSONB,
    "afterValue" JSONB,
    "actorUserId" UUID,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseFieldValueHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseFieldValue_tenantId_caseId_idx" ON "CaseFieldValue"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "CaseFieldValue_tenantId_fieldId_idx" ON "CaseFieldValue"("tenantId", "fieldId");

-- CreateIndex
CREATE INDEX "CaseFieldValue_deletedAt_idx" ON "CaseFieldValue"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CaseFieldValue_tenantId_caseId_fieldId_key" ON "CaseFieldValue"("tenantId", "caseId", "fieldId");

-- CreateIndex
CREATE INDEX "CaseFieldValueOption_tenantId_idx" ON "CaseFieldValueOption"("tenantId");

-- CreateIndex
CREATE INDEX "CaseFieldValueOption_valueId_idx" ON "CaseFieldValueOption"("valueId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseFieldValueOption_valueId_optionId_key" ON "CaseFieldValueOption"("valueId", "optionId");

-- CreateIndex
CREATE INDEX "CaseFieldValueHistory_tenantId_caseId_idx" ON "CaseFieldValueHistory"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "CaseFieldValueHistory_tenantId_fieldId_idx" ON "CaseFieldValueHistory"("tenantId", "fieldId");

-- CreateIndex
CREATE INDEX "CaseFieldValueHistory_changedAt_idx" ON "CaseFieldValueHistory"("changedAt");

-- AddForeignKey
ALTER TABLE "CaseFieldValue" ADD CONSTRAINT "CaseFieldValue_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "DocCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFieldValue" ADD CONSTRAINT "CaseFieldValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "CaseFieldDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFieldValue" ADD CONSTRAINT "CaseFieldValue_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "CaseFieldOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFieldValueOption" ADD CONSTRAINT "CaseFieldValueOption_valueId_fkey" FOREIGN KEY ("valueId") REFERENCES "CaseFieldValue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFieldValueOption" ADD CONSTRAINT "CaseFieldValueOption_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "CaseFieldOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

