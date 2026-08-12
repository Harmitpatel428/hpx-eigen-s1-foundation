-- Migration: seed user:impersonate permission and grant to Organization Admin roles
-- Idempotent: ON CONFLICT DO NOTHING / NOT EXISTS guards prevent duplicate rows.

-- Step 1: Ensure user:impersonate permission record exists in the global Permission table
INSERT INTO "Permission" ("id", "slug", "module", "description")
VALUES (gen_random_uuid(), 'user:impersonate', 'Admin', 'Impersonate another user (admin only)')
ON CONFLICT ("slug") DO NOTHING;

-- Step 2: Grant user:impersonate to every Organization Admin role that doesn't already have it
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r
JOIN "Permission" p ON p.slug = 'user:impersonate'
WHERE r.name = 'Organization Admin'
  AND r."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "RolePermission" rp
    WHERE rp."roleId" = r.id
      AND rp."permissionId" = p.id
  );
