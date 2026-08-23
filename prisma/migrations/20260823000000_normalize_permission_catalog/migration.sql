-- Normalize the Permission catalog to the canonical 43-slug set.
--
-- History: the seed was additive-only, so retired slugs from earlier seeds
-- lingered in prod (51 rows) while never being enforced by any route.
-- This brings every environment to exactly the seed-permissions.ts catalog:
--   - removes doc:audit:view (guards no endpoint) and any other non-canonical row
--   - adds payment:delete (DELETE /payments/:id now enforces it)
-- RolePermission refs cascade (schema onDelete: Cascade), so custom-role
-- grants pointing at removed slugs are cleaned up automatically.
--
-- Idempotent: NOT IN / ON CONFLICT guards make reruns a no-op.

INSERT INTO "Permission" ("id", "slug", "module", "description")
VALUES (gen_random_uuid(), 'payment:delete', 'Payments', 'Delete payments')
ON CONFLICT ("slug") DO NOTHING;

DELETE FROM "Permission"
WHERE "slug" NOT IN (
  -- Leads
  'lead:view', 'lead:create', 'lead:edit', 'lead:delete', 'lead:assign',
  -- Contacts
  'contact:view', 'contact:create', 'contact:edit', 'contact:delete',
  -- Opportunities
  'opportunity:view', 'opportunity:create', 'opportunity:edit', 'opportunity:delete',
  -- Activities
  'activity:view', 'activity:create', 'activity:edit', 'activity:delete',
  -- Invoices
  'invoice:view', 'invoice:create', 'invoice:edit', 'invoice:delete',
  -- Payments
  'payment:view', 'payment:create', 'payment:edit', 'payment:delete',
  -- Roles & Admin
  'role:view', 'role:manage', 'audit:view',
  -- Users
  'user:view', 'user:manage', 'user:impersonate',
  -- Departments & Teams
  'department:view', 'department:manage', 'team:view', 'team:manage',
  -- Documentation Tracker
  'doc:view', 'doc:create', 'doc:edit', 'doc:verify', 'doc:override',
  'doc:transfer', 'doc:preset:view', 'doc:preset:manage'
);
