-- SAFETY-REVIEWED: WP-1 PR-1 / reg #10 — remove the V10 unrestricted 'user:impersonate'
-- permission and its role grants. The impersonation endpoints, the settings toggle, and the
-- seed entry are removed in the same PR; anti-resurrection is guarded by
-- tests/unit/impersonation-removed.test.ts. The replacement is the scoped, time-boxed
-- support_access_grant [NEXT].
--
-- Deleting the Permission row would cascade RolePermission (onDelete: Cascade); we delete the
-- grants explicitly first for clarity and audit-friendliness. Idempotent: no-op if already gone.

DELETE FROM "RolePermission"
  USING "Permission"
  WHERE "RolePermission"."permissionId" = "Permission"."id"
    AND "Permission"."slug" = 'user:impersonate';

DELETE FROM "Permission" WHERE "slug" = 'user:impersonate';
