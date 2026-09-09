-- Grant all Documentation permissions to Organization Admin.
-- doc:view and its siblings exist in the Permission catalog (added in
-- 20260823_normalize_permission_catalog) but were never granted to any role
-- via migration — causing a 403 on GET /api/v1/documentation/cases and an
-- empty Documentation page after a successful handoff.

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."name" = 'Organization Admin'
  AND p."slug" IN (
    'doc:view', 'doc:create', 'doc:edit', 'doc:verify', 'doc:override',
    'doc:transfer', 'doc:preset:view', 'doc:preset:manage'
  )
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
