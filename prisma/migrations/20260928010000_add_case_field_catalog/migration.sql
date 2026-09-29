-- CreateEnum
CREATE TYPE "CaseFieldStatus" AS ENUM ('DRAFT', 'ACTIVE', 'READ_ONLY', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CaseFieldType" AS ENUM ('TEXT', 'TEXTAREA', 'NUMBER', 'DECIMAL', 'CURRENCY', 'PERCENTAGE', 'DATE', 'DATETIME', 'TIME', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'EMAIL', 'PHONE', 'URL', 'USER_REFERENCE', 'DEPARTMENT_REFERENCE', 'CASE_REFERENCE', 'DOCUMENT_REFERENCE');

-- CreateEnum
CREATE TYPE "CaseFieldConditionOperator" AS ENUM ('EQUALS', 'NOT_EQUALS', 'IS_EMPTY', 'IS_NOT_EMPTY', 'GREATER_THAN', 'LESS_THAN', 'IN', 'NOT_IN');

-- CreateEnum
CREATE TYPE "CaseFieldRuleEffectType" AS ENUM ('REQUIRE_FIELD');

-- CreateTable
CREATE TABLE "CaseFieldDefinition" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "CaseFieldType" NOT NULL,
    "status" "CaseFieldStatus" NOT NULL DEFAULT 'DRAFT',
    "owningDepartmentId" UUID NOT NULL,
    "validationRules" JSONB NOT NULL DEFAULT '{}',
    "visibility" JSONB NOT NULL DEFAULT '{}',
    "reportable" BOOLEAN NOT NULL DEFAULT false,
    "filterable" BOOLEAN NOT NULL DEFAULT false,
    "sortable" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CaseFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseFieldOption" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "fieldId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "parentOptionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CaseFieldOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseFieldRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "conditionFieldId" UUID NOT NULL,
    "conditionOperator" "CaseFieldConditionOperator" NOT NULL,
    "conditionValue" JSONB NOT NULL DEFAULT 'null',
    "conditionOptionId" UUID,
    "effectType" "CaseFieldRuleEffectType" NOT NULL DEFAULT 'REQUIRE_FIELD',
    "targetFieldId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CaseFieldRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseFieldDefinition_tenantId_idx" ON "CaseFieldDefinition"("tenantId");

-- CreateIndex
CREATE INDEX "CaseFieldDefinition_tenantId_status_idx" ON "CaseFieldDefinition"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CaseFieldDefinition_deletedAt_idx" ON "CaseFieldDefinition"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CaseFieldDefinition_tenantId_key_key" ON "CaseFieldDefinition"("tenantId", "key");

-- CreateIndex
CREATE INDEX "CaseFieldOption_tenantId_fieldId_idx" ON "CaseFieldOption"("tenantId", "fieldId");

-- CreateIndex
CREATE INDEX "CaseFieldOption_deletedAt_idx" ON "CaseFieldOption"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CaseFieldOption_tenantId_fieldId_key_key" ON "CaseFieldOption"("tenantId", "fieldId", "key");

-- CreateIndex
CREATE INDEX "CaseFieldRule_tenantId_idx" ON "CaseFieldRule"("tenantId");

-- CreateIndex
CREATE INDEX "CaseFieldRule_tenantId_conditionFieldId_idx" ON "CaseFieldRule"("tenantId", "conditionFieldId");

-- CreateIndex
CREATE INDEX "CaseFieldRule_tenantId_targetFieldId_idx" ON "CaseFieldRule"("tenantId", "targetFieldId");

-- CreateIndex
CREATE INDEX "CaseFieldRule_deletedAt_idx" ON "CaseFieldRule"("deletedAt");

-- AddForeignKey
ALTER TABLE "CaseFieldDefinition" ADD CONSTRAINT "CaseFieldDefinition_owningDepartmentId_fkey" FOREIGN KEY ("owningDepartmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFieldOption" ADD CONSTRAINT "CaseFieldOption_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "CaseFieldDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFieldOption" ADD CONSTRAINT "CaseFieldOption_parentOptionId_fkey" FOREIGN KEY ("parentOptionId") REFERENCES "CaseFieldOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFieldRule" ADD CONSTRAINT "CaseFieldRule_conditionFieldId_fkey" FOREIGN KEY ("conditionFieldId") REFERENCES "CaseFieldDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFieldRule" ADD CONSTRAINT "CaseFieldRule_targetFieldId_fkey" FOREIGN KEY ("targetFieldId") REFERENCES "CaseFieldDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFieldRule" ADD CONSTRAINT "CaseFieldRule_conditionOptionId_fkey" FOREIGN KEY ("conditionOptionId") REFERENCES "CaseFieldOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

