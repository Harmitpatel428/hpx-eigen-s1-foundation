-- Seed mandate lifecycle permissions.
INSERT INTO "Permission" ("id", "slug", "module", "description")
VALUES
  (gen_random_uuid(), 'mandate:send',   'Documentation', 'Send mandate upload requests to clients'),
  (gen_random_uuid(), 'mandate:verify', 'Documentation', 'Verify or reject uploaded mandate documents'),
  (gen_random_uuid(), 'mandate:view',   'Documentation', 'View mandate requests and uploads for a case')
ON CONFLICT ("slug") DO NOTHING;

-- Grant all three to Organization Admin.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."name" = 'Organization Admin'
  AND p."slug" IN ('mandate:send', 'mandate:verify', 'mandate:view')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;