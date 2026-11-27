-- Process department Phase 0 — RBAC: two permissions + the Manager/Executive role split.
-- Additive only, idempotent, NO schema DDL (no table/column/enum changes). Modeled on
-- 20261019000100_doc_to_process_phase3. Mirrors prisma/seed-permissions.ts (the canonical
-- role/perm path); this migration exists so a migrate-deploy-only environment (e.g. the test
-- DB) has the rows without running the seed script.
--
-- IMPORTANT: perm_version lives in Redis, NOT in SQL — this migration does NOT bump it.
-- Post-deploy you MUST run `npx tsx prisma/seed-permissions.ts` to bump perm_version
-- (invalidate the cached permission manifests) and reconcile roles canonically.

-- ─── Permissions: Process Phase 0 (least privilege, one key per action) ─────
INSERT INTO "Permission" ("id", "slug", "module", "description")
VALUES
  (gen_random_uuid(), 'process:case:view-all', 'Process', 'View the full Process case queue; without it a process:view user sees only cases where processAssignedTo = self'),
  (gen_random_uuid(), 'process:assign',        'Process', 'Assign a Process case to a Process Executive (writes processAssignedTo)')
ON CONFLICT ("slug") DO NOTHING;

-- ─── Roles: create Process Manager + Process Executive for EVERY tenant ─────
-- @@unique([tenantId, name]) backs ON CONFLICT → a re-run is a no-op.
-- "updatedAt" is a Prisma @updatedAt column with no DB default, so supply it (and createdAt).
INSERT INTO "Role" ("id", "tenantId", "name", "createdAt", "updatedAt")
SELECT gen_random_uuid(), t."id", r."name", now(), now()
FROM "Tenant" t
CROSS JOIN (VALUES ('Process Manager'), ('Process Executive')) AS r("name")
ON CONFLICT ("tenantId", "name") DO NOTHING;

-- ─── RolePermission mappings for the two new roles ──────────────────────────
-- Process Manager → all five Process permissions.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p
  ON p."slug" IN ('process:view', 'process:accept', 'process:return', 'process:case:view-all', 'process:assign')
WHERE r."name" = 'Process Manager'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- Process Executive → the three base queue permissions only (no view-all, no assign).
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p
  ON p."slug" IN ('process:view', 'process:accept', 'process:return')
WHERE r."name" = 'Process Executive'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- Keep Organization Admin all-perms (seed-permissions.ts also reconciles this): grant the
-- two new permissions so a migrate-deploy-only environment has them on the admin role.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."name" = 'Organization Admin'
  AND p."slug" IN ('process:case:view-all', 'process:assign')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
