-- CreateEnum
CREATE TYPE "CaseStageStatus" AS ENUM ('PENDING', 'READY', 'IN_PROGRESS', 'WAITING_EXTERNAL', 'BLOCKED', 'COMPLETED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "CaseStageDurationType" AS ENUM ('DAYS', 'WEEKS', 'MONTHS');

-- CreateEnum
CREATE TYPE "CaseTimelineStatus" AS ENUM ('ACTIVE', 'COMPLETED');

-- CreateTable
CREATE TABLE "CaseStageTemplate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseTypeId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "durationValue" INTEGER,
    "durationType" "CaseStageDurationType",
    "externalWaiting" BOOLEAN NOT NULL DEFAULT false,
    "bufferDays" INTEGER,
    "dependsOnPrevious" BOOLEAN NOT NULL DEFAULT true,
    "enforceRequiredOnComplete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CaseStageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseTimeline" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "caseTypeId" UUID NOT NULL,
    "status" "CaseTimelineStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseTimeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseStage" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "timelineId" UUID NOT NULL,
    "templateId" UUID,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "status" "CaseStageStatus" NOT NULL DEFAULT 'PENDING',
    "durationValue" INTEGER,
    "durationType" "CaseStageDurationType",
    "externalWaiting" BOOLEAN NOT NULL DEFAULT false,
    "bufferDays" INTEGER,
    "dependsOnPrevious" BOOLEAN NOT NULL DEFAULT true,
    "enforceRequiredOnComplete" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseStageEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "stageId" UUID NOT NULL,
    "eventType" VARCHAR(32) NOT NULL,
    "fromStatus" "CaseStageStatus",
    "toStatus" "CaseStageStatus",
    "actorUserId" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseStageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseStageTemplate_tenantId_caseTypeId_idx" ON "CaseStageTemplate"("tenantId", "caseTypeId");

-- CreateIndex
CREATE INDEX "CaseStageTemplate_deletedAt_idx" ON "CaseStageTemplate"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CaseStageTemplate_tenantId_caseTypeId_key_key" ON "CaseStageTemplate"("tenantId", "caseTypeId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "CaseTimeline_caseId_key" ON "CaseTimeline"("caseId");

-- CreateIndex
CREATE INDEX "CaseTimeline_tenantId_idx" ON "CaseTimeline"("tenantId");

-- CreateIndex
CREATE INDEX "CaseStage_tenantId_timelineId_idx" ON "CaseStage"("tenantId", "timelineId");

-- CreateIndex
CREATE INDEX "CaseStage_tenantId_status_idx" ON "CaseStage"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CaseStage_tenantId_timelineId_key_key" ON "CaseStage"("tenantId", "timelineId", "key");

-- CreateIndex
CREATE INDEX "CaseStageEvent_tenantId_stageId_idx" ON "CaseStageEvent"("tenantId", "stageId");

-- CreateIndex
CREATE INDEX "CaseStageEvent_tenantId_caseId_idx" ON "CaseStageEvent"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "CaseStageEvent_createdAt_idx" ON "CaseStageEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "CaseStageTemplate" ADD CONSTRAINT "CaseStageTemplate_caseTypeId_fkey" FOREIGN KEY ("caseTypeId") REFERENCES "CaseType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseTimeline" ADD CONSTRAINT "CaseTimeline_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "DocCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseStage" ADD CONSTRAINT "CaseStage_timelineId_fkey" FOREIGN KEY ("timelineId") REFERENCES "CaseTimeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseStage" ADD CONSTRAINT "CaseStage_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "CaseStageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseStageEvent" ADD CONSTRAINT "CaseStageEvent_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "CaseStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

