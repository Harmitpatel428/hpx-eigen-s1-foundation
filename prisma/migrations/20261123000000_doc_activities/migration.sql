-- DocActivity: Documentation-department case timeline / follow-ups.
-- Physically separate from LeadActivity so Documentation rows can never surface
-- in Sales activity queries (/activities, /leads/:id/activities).

-- CreateEnum
CREATE TYPE "DocActivityType" AS ENUM ('FOLLOW_UP', 'CALL', 'MEETING', 'DOC_REQUESTED', 'NOTE', 'OTHER');

-- CreateEnum
CREATE TYPE "DocActivityState" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "DocActivity" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "actorUserId" UUID,
    "type" "DocActivityType" NOT NULL,
    "state" "DocActivityState" NOT NULL DEFAULT 'COMPLETED',
    "subject" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "scheduledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocActivity_tenantId_caseId_idx" ON "DocActivity"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "DocActivity_tenantId_caseId_createdAt_idx" ON "DocActivity"("tenantId", "caseId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "DocActivity_tenantId_scheduledAt_idx" ON "DocActivity"("tenantId", "scheduledAt");

-- CreateIndex
CREATE INDEX "DocActivity_caseId_state_idx" ON "DocActivity"("caseId", "state");

-- CreateIndex
CREATE INDEX "DocActivity_deletedAt_idx" ON "DocActivity"("deletedAt");

-- AddForeignKey
ALTER TABLE "DocActivity" ADD CONSTRAINT "DocActivity_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "DocCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
