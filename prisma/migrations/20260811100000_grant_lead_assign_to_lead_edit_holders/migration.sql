-- Migration: grant lead:assign to every role that already has lead:edit
-- This is purely ADDITIVE — no existing records deleted.
-- Rationale: bulk-assign routes are changing guard from lead:edit → lead:assign.
-- Any role relying on lead:edit for assignment retains access after this migration.

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT rp."roleId", p_assign.id
FROM "RolePermission" rp
JOIN "Permission" p_edit   ON rp."permissionId" = p_edit.id   AND p_edit.slug = 'lead:edit'
JOIN "Permission" p_assign ON p_assign.slug = 'lead:assign'
WHERE NOT EXISTS (
  SELECT 1 FROM "RolePermission" rp2
  WHERE rp2."roleId" = rp."roleId"
    AND rp2."permissionId" = p_assign.id
);
