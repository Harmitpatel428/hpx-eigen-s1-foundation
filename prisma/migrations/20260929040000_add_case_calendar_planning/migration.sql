-- AlterTable
ALTER TABLE "CaseStage" ADD COLUMN     "baselineFinish" DATE,
ADD COLUMN     "baselineStart" DATE,
ADD COLUMN     "latestFinish" DATE,
ADD COLUMN     "latestStart" DATE,
ADD COLUMN     "plannedFinish" DATE,
ADD COLUMN     "plannedStart" DATE,
ADD COLUMN     "remainingDurationOverride" INTEGER;

-- AlterTable
ALTER TABLE "CaseTimeline" ADD COLUMN     "deficitDays" INTEGER,
ADD COLUMN     "exceptionApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "exceptionApprovedAt" TIMESTAMP(3),
ADD COLUMN     "exceptionApprovedBy" UUID,
ADD COLUMN     "exceptionReason" TEXT,
ADD COLUMN     "feasible" BOOLEAN,
ADD COLUMN     "lastPlannedAt" TIMESTAMP(3),
ADD COLUMN     "targetDate" DATE;

-- CreateTable
CREATE TABLE "WorkingCalendar" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "workingWeekdays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "timezone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkingCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarHoliday" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "calendarId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkingCalendar_tenantId_key" ON "WorkingCalendar"("tenantId");

-- CreateIndex
CREATE INDEX "CalendarHoliday_tenantId_calendarId_idx" ON "CalendarHoliday"("tenantId", "calendarId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarHoliday_tenantId_calendarId_date_key" ON "CalendarHoliday"("tenantId", "calendarId", "date");

-- AddForeignKey
ALTER TABLE "CalendarHoliday" ADD CONSTRAINT "CalendarHoliday_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "WorkingCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

