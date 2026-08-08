-- CreateTable LeadNote
CREATE TABLE "LeadNote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "content" VARCHAR(500) NOT NULL,
    "followUpDate" TIMESTAMP(3),
    "followUpTime" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "LeadNote_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "LeadNote" ADD CONSTRAINT "LeadNote_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddIndexes
CREATE INDEX "LeadNote_leadId_idx" ON "LeadNote"("leadId");
CREATE INDEX "LeadNote_tenantId_idx" ON "LeadNote"("tenantId");
CREATE INDEX "LeadNote_createdAt_idx" ON "LeadNote"("createdAt");
