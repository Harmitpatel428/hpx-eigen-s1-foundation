/*
  Warnings:

  - Made the column `departmentId` on table `Contact` required. This step will fail if there are existing NULL values in that column.
  - Made the column `ownerId` on table `Contact` required. This step will fail if there are existing NULL values in that column.
  - Made the column `ownerId` on table `Lead` required. This step will fail if there are existing NULL values in that column.
  - Made the column `departmentId` on table `Lead` required. This step will fail if there are existing NULL values in that column.
  - Made the column `departmentId` on table `Opportunity` required. This step will fail if there are existing NULL values in that column.
  - Made the column `identityId` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Contact" ALTER COLUMN "departmentId" SET NOT NULL,
ALTER COLUMN "ownerId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Lead" ALTER COLUMN "ownerId" SET NOT NULL,
ALTER COLUMN "departmentId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Opportunity" ALTER COLUMN "departmentId" SET NOT NULL;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "identityId" SET NOT NULL;

-- Enable Row-Level Security
ALTER TABLE "Lead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Opportunity" ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "lead_tenant_department_isolation" ON "Lead";
DROP POLICY IF EXISTS "contact_tenant_department_isolation" ON "Contact";
DROP POLICY IF EXISTS "opportunity_tenant_department_isolation" ON "Opportunity";

-- Create RLS Policies
CREATE POLICY "lead_tenant_department_isolation" ON "Lead"
USING (
  "tenantId" = current_setting('app.current_tenant_id')::uuid 
  AND (
    "departmentId" = current_setting('app.current_department_id')::uuid
    OR current_setting('app.is_superadmin')::boolean = true
  )
);

CREATE POLICY "contact_tenant_department_isolation" ON "Contact"
USING (
  "tenantId" = current_setting('app.current_tenant_id')::uuid 
  AND (
    "departmentId" = current_setting('app.current_department_id')::uuid
    OR current_setting('app.is_superadmin')::boolean = true
  )
);

CREATE POLICY "opportunity_tenant_department_isolation" ON "Opportunity"
USING (
  "tenantId" = current_setting('app.current_tenant_id')::uuid 
  AND (
    "departmentId" = current_setting('app.current_department_id')::uuid
    OR current_setting('app.is_superadmin')::boolean = true
  )
);
