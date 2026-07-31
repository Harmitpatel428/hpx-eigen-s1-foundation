-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ONBOARDING', 'IN_PROGRESS', 'REVIEW', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ProjectPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ONBOARDING',
    "priority" "ProjectPriority" NOT NULL DEFAULT 'MEDIUM',
    "dueDate" TIMESTAMP(3),
    "tag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_tenantId_departmentId_idx" ON "Project"("tenantId", "departmentId");

-- CreateIndex
CREATE INDEX "Project_tenantId_ownerId_idx" ON "Project"("tenantId", "ownerId");

-- CreateIndex
CREATE INDEX "Project_tenantId_status_idx" ON "Project"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Project_deletedAt_idx" ON "Project"("deletedAt");

-- CreateIndex
CREATE INDEX "Document_tenantId_departmentId_idx" ON "Document"("tenantId", "departmentId");

-- CreateIndex
CREATE INDEX "Document_tenantId_ownerId_idx" ON "Document"("tenantId", "ownerId");

-- CreateIndex
CREATE INDEX "Document_tenantId_status_idx" ON "Document"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Document_deletedAt_idx" ON "Document"("deletedAt");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Row-Level Security: Project ───────────────────────────────────────────────

-- Enable RLS
ALTER TABLE "Project" ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (idempotent)
DROP POLICY IF EXISTS "project_tenant_department_isolation" ON "Project";

-- Create policy — tenant + department isolation
CREATE POLICY "project_tenant_department_isolation" ON "Project"
USING (
  "tenantId" = current_setting('app.current_tenant_id', true)::uuid
  AND (
    current_setting('app.is_super_admin', true) = 'true'
    OR "departmentId" = current_setting('app.current_department_id', true)::uuid
  )
)
WITH CHECK (
  "tenantId" = current_setting('app.current_tenant_id', true)::uuid
  AND (
    current_setting('app.is_super_admin', true) = 'true'
    OR "departmentId" = current_setting('app.current_department_id', true)::uuid
  )
);

-- ─── Row-Level Security: Document ──────────────────────────────────────────────

-- Enable RLS
ALTER TABLE "Document" ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (idempotent)
DROP POLICY IF EXISTS "document_tenant_department_isolation" ON "Document";

-- Create policy — tenant + department isolation
CREATE POLICY "document_tenant_department_isolation" ON "Document"
USING (
  "tenantId" = current_setting('app.current_tenant_id', true)::uuid
  AND (
    current_setting('app.is_super_admin', true) = 'true'
    OR "departmentId" = current_setting('app.current_department_id', true)::uuid
  )
)
WITH CHECK (
  "tenantId" = current_setting('app.current_tenant_id', true)::uuid
  AND (
    current_setting('app.is_super_admin', true) = 'true'
    OR "departmentId" = current_setting('app.current_department_id', true)::uuid
  )
);

