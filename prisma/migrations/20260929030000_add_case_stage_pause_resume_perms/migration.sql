-- Phase 6: two new Case Operations Engine stage permissions (pause/resume).
-- Additive + idempotent, following the mandate-permission precedent.

INSERT INTO "Permission" ("id", "slug", "module", "description")
VALUES
  (gen_random_uuid(), 'case-stage:pause',  'Case Engine', 'Pause a case stage (mark waiting on an external party)'),
  (gen_random_uuid(), 'case-stage:resume', 'Case Engine', 'Resume a paused case stage')
ON CONFLICT ("slug") DO NOTHING;

-- Grant both to each tenant's Organization Admin role.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."name" = 'Organization Admin'
  AND p."slug" IN ('case-stage:pause', 'case-stage:resume')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
