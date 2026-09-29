-- CreateTable
CREATE TABLE "StagePerformanceSummary" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseTypeId" UUID,
    "stageKey" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "medianDays" DOUBLE PRECISION NOT NULL,
    "recentMedianDays" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StagePerformanceSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StagePerformanceSummary_tenantId_stageKey_idx" ON "StagePerformanceSummary"("tenantId", "stageKey");

-- CreateIndex
CREATE UNIQUE INDEX "StagePerformanceSummary_tenantId_caseTypeId_stageKey_key" ON "StagePerformanceSummary"("tenantId", "caseTypeId", "stageKey");

-- Tenant-wide row (caseTypeId NULL): Postgres treats NULLs as distinct, so the
-- unique above does not cover it. Partial index is migration-only (Prisma
-- cannot express it); recorded in scripts/expected-drift.sql.
CREATE UNIQUE INDEX "StagePerformanceSummary_tenant_stageKey_null_ctype_key" ON "StagePerformanceSummary" ("tenantId", "stageKey") WHERE "caseTypeId" IS NULL;
