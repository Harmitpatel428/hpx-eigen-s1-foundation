-- Phase 3 — Documentation → Process handover: audit event types + permissions.
-- Additive only. ALTER TYPE ... ADD VALUE is forward-only (see Phase 1 migration
-- note); permission INSERTs are idempotent (ON CONFLICT DO NOTHING).

-- ─── DocEventType: process-handoff audit events ─────────────────────────────
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'PROCESS_REVIEW_REQUESTED';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'PROCESS_HANDOFF_ACCEPTED';
ALTER TYPE "DocEventType" ADD VALUE IF NOT EXISTS 'PROCESS_HANDOFF_RETURNED';

-- ─── Permissions: Process department (least privilege, one key per action) ──
INSERT INTO "Permission" ("id", "slug", "module", "description")
VALUES
  (gen_random_uuid(), 'process:view',   'Process', 'View the Process incoming queue'),
  (gen_random_uuid(), 'process:accept', 'Process', 'Accept a case handed to the Process department'),
  (gen_random_uuid(), 'process:return', 'Process', 'Return a case to Documentation from the Process queue')
ON CONFLICT ("slug") DO NOTHING;

-- Grant all three to Organization Admin (seed-permissions.ts also reconciles this,
-- but seed the grant here so a migrate-deploy-only environment — e.g. the test DB —
-- has the admin grant without running the seed script).
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."name" = 'Organization Admin'
  AND p."slug" IN ('process:view', 'process:accept', 'process:return')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
