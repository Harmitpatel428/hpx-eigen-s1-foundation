-- Phase 0 follow-up (found in live smoke): the Process Manager assign flow calls
-- GET /users to populate the assignee picker, which needs `user:view`. Without it the
-- picker is empty and assignment is unusable through the UI. Mirrors Sales Manager, which
-- already holds user:view. The permission already exists — this only adds the mapping for
-- the Process Manager role, for every tenant. Idempotent, additive, NO schema DDL.
--
-- Separate migration (not an edit of 20261127000000) so the already-applied migration's
-- checksum is never altered. perm_version (Redis) is bumped post-deploy by seed-permissions.ts.

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."slug" = 'user:view'
WHERE r."name" = 'Process Manager'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
