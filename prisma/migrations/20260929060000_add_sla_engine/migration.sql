-- CreateEnum
CREATE TYPE "CaseStageSlaState" AS ENUM ('ON_TRACK', 'AT_RISK', 'OVERDUE', 'WAITING_EXTERNAL', 'COMPLETED_ON_TIME', 'COMPLETED_LATE', 'EXCEPTION_APPROVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'CASE_STAGE_AT_RISK';
ALTER TYPE "NotificationType" ADD VALUE 'CASE_STAGE_OVERDUE';

-- AlterTable
ALTER TABLE "CaseStage" ADD COLUMN     "atRiskPercent" INTEGER,
ADD COLUMN     "hardBlock" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hardBlockUnlockedAt" TIMESTAMP(3),
ADD COLUMN     "hardBlockUnlockedBy" UUID,
ADD COLUMN     "hardBlockUnlockedReason" TEXT,
ADD COLUMN     "slaNotifiedForState" "CaseStageSlaState",
ADD COLUMN     "slaState" "CaseStageSlaState",
ADD COLUMN     "warnDaysRemaining" INTEGER;

-- AlterTable
ALTER TABLE "CaseStageTemplate" ADD COLUMN     "atRiskPercent" INTEGER,
ADD COLUMN     "hardBlock" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "warnDaysRemaining" INTEGER;
