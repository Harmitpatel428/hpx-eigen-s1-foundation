-- Permission: tenant-scoped (resource, action) → global (slug, module)
-- RolePermission: uuid PK + soft-delete → composite PK (roleId, permissionId), no soft-delete
-- No data migration required: Permission rows are seeded by later migrations, not app code.

-- ── Permission ─────────────────────────────────────────────────────────────────

ALTER TABLE "Permission" DROP CONSTRAINT "Permission_tenantId_fkey";

DROP INDEX "Permission_tenantId_idx";
DROP INDEX "Permission_deletedAt_idx";
DROP INDEX "Permission_tenantId_resource_action_key";

ALTER TABLE "Permission"
  ADD COLUMN "slug"   TEXT,
  ADD COLUMN "module" TEXT;

ALTER TABLE "Permission"
  DROP COLUMN "tenantId",
  DROP COLUMN "resource",
  DROP COLUMN "action",
  DROP COLUMN "createdAt",
  DROP COLUMN "updatedAt",
  DROP COLUMN "deletedAt";

-- Safe to set NOT NULL: no rows exist on fresh provisioning.
ALTER TABLE "Permission" ALTER COLUMN "slug"   SET NOT NULL;
ALTER TABLE "Permission" ALTER COLUMN "module" SET NOT NULL;

CREATE UNIQUE INDEX "Permission_slug_key" ON "Permission"("slug");

-- ── RolePermission ─────────────────────────────────────────────────────────────

ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_pkey";

DROP INDEX "RolePermission_roleId_permissionId_key";

ALTER TABLE "RolePermission"
  DROP COLUMN "id",
  DROP COLUMN "createdAt",
  DROP COLUMN "deletedAt";

ALTER TABLE "RolePermission"
  ADD CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId", "permissionId");
