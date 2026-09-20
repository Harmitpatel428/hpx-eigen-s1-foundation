-- Seed firm direct-upload permissions and grant them to Organization Admin.
-- Idempotent on BOTH inserts (safe to re-run) — mirrors 20260911110000_seed_mandate_permissions.
INSERT INTO "Permission" ("id", "slug", "module", "description")
VALUES
  (gen_random_uuid(), 'mandate:upload',  'Documentation', 'Upload a mandate document directly from the CRM (firm-side)'),
  (gen_random_uuid(), 'doc:upload',      'Documentation', 'Upload required/general documents directly from the CRM (firm-side)'),
  (gen_random_uuid(), 'doc:file:manage', 'Documentation', 'Manage uploaded document files (status change, replace, remove)')
ON CONFLICT ("slug") DO NOTHING;

-- Grant all three to Organization Admin.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."name" = 'Organization Admin'
  AND p."slug" IN ('mandate:upload', 'doc:upload', 'doc:file:manage')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
