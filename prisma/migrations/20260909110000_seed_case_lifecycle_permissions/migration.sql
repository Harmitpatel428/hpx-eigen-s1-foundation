-- Seed case lifecycle permissions.
INSERT INTO "Permission" ("id", "slug", "module", "description")
VALUES
  (gen_random_uuid(), 'cases:generate-id', 'Documentation', 'Manually generate a Case ID for a DocCase'),
  (gen_random_uuid(), 'cases:close',       'Documentation', 'Close a case without documentation'),
  (gen_random_uuid(), 'cases:reopen',      'Documentation', 'Reopen a closed case')
ON CONFLICT ("slug") DO NOTHING;

-- Grant all three to Organization Admin.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."name" = 'Organization Admin'
  AND p."slug" IN ('cases:generate-id', 'cases:close', 'cases:reopen')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
