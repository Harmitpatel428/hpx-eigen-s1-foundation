-- Seed the portal:activate permission for the new POST
-- /cases/:caseId/portal/activate endpoint.

INSERT INTO "Permission" ("id", "slug", "module", "description")
VALUES (gen_random_uuid(), 'portal:activate', 'Client Portal', 'Activate client portal access for a DocCase')
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."name" = 'Organization Admin'
  AND p."slug" = 'portal:activate'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
