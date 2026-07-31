-- Enable RLS on CRM entities
ALTER TABLE "Lead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Opportunity" ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist to avoid migration errors
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
