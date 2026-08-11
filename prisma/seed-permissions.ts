/**
 * Permission & Role Seeding Script
 *
 * SAFE TO RUN IN PRODUCTION — idempotent, additive only for user assignments.
 *
 * What this does:
 *   1. Upserts all canonical Permission slugs
 *   2. For each tenant: upserts Organization Admin role with all permissions
 *   3. Assigns Organization Admin to users listed in SEED_ADMIN_EMAILS (comma-separated)
 *   4. Upserts preset roles (Sales Manager, Sales Executive) per tenant
 *   5. Invalidates Redis permission cache
 *
 * What this does NOT do:
 *   - Does NOT assign Organization Admin to every user in the database
 *   - Does NOT overwrite custom role-permission assignments on non-admin roles
 *   - Does NOT delete any user, role, or tenant
 *
 * Usage:
 *   SEED_ADMIN_EMAILS=admin@example.com npx tsx prisma/seed-permissions.ts
 *   SEED_ADMIN_EMAILS=a@x.com,b@x.com npx tsx prisma/seed-permissions.ts
 *
 * If SEED_ADMIN_EMAILS is not set, user-role assignment is skipped (permissions
 * and roles are still seeded). This is safe to run in CI without that variable.
 */
import 'dotenv/config';
import { PrismaClient, ScopeType } from '@prisma/client';
import { PermissionService } from '../src/services/permission.service';

const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);

const PERMISSIONS = [
  // Leads
  { slug: 'lead:view',   module: 'Leads',   description: 'View leads' },
  { slug: 'lead:create', module: 'Leads',   description: 'Create new leads' },
  { slug: 'lead:edit',   module: 'Leads',   description: 'Edit lead details' },
  { slug: 'lead:delete', module: 'Leads',   description: 'Delete (soft-delete) leads' },
  { slug: 'lead:assign', module: 'Leads',   description: 'Reassign lead owner' },
  // Contacts
  { slug: 'contact:view',   module: 'Contacts', description: 'View contacts' },
  { slug: 'contact:create', module: 'Contacts', description: 'Create new contacts' },
  { slug: 'contact:edit',   module: 'Contacts', description: 'Edit contact details' },
  { slug: 'contact:delete', module: 'Contacts', description: 'Delete (soft-delete) contacts' },
  // Opportunities
  { slug: 'opportunity:view',   module: 'Opportunities', description: 'View opportunities' },
  { slug: 'opportunity:create', module: 'Opportunities', description: 'Create new opportunities' },
  { slug: 'opportunity:edit',   module: 'Opportunities', description: 'Edit opportunity details' },
  { slug: 'opportunity:delete', module: 'Opportunities', description: 'Delete (soft-delete) opportunities' },
  // Activities
  { slug: 'activity:view',   module: 'Activities', description: 'View activities' },
  { slug: 'activity:create', module: 'Activities', description: 'Create new activities' },
  { slug: 'activity:edit',   module: 'Activities', description: 'Edit activity details' },
  { slug: 'activity:delete', module: 'Activities', description: 'Delete (soft-delete) activities' },
  // Invoices
  { slug: 'invoice:view',   module: 'Invoices', description: 'View invoices' },
  { slug: 'invoice:create', module: 'Invoices', description: 'Create new invoices' },
  { slug: 'invoice:edit',   module: 'Invoices', description: 'Edit invoice details' },
  { slug: 'invoice:delete', module: 'Invoices', description: 'Delete (soft-delete) invoices' },
  // Payments
  { slug: 'payment:view',   module: 'Payments', description: 'View payments' },
  { slug: 'payment:create', module: 'Payments', description: 'Record payments' },
  { slug: 'payment:edit',   module: 'Payments', description: 'Edit payment details' },
  // Roles & Admin
  { slug: 'role:view',   module: 'Admin', description: 'View roles and permissions' },
  { slug: 'role:manage', module: 'Admin', description: 'Create, edit, and delete roles' },
  { slug: 'audit:view',  module: 'Admin', description: 'View immutable audit logs' },
  // Users
  { slug: 'user:view',        module: 'Admin', description: 'View users' },
  { slug: 'user:manage',      module: 'Admin', description: 'Invite, suspend, and manage users' },
  { slug: 'user:impersonate', module: 'Admin', description: 'Impersonate another user (admin only)' },
  // Departments & Teams
  { slug: 'department:view',   module: 'Admin', description: 'View departments' },
  { slug: 'department:manage', module: 'Admin', description: 'Create, edit, delete departments' },
  { slug: 'team:view',   module: 'Admin', description: 'View teams' },
  { slug: 'team:manage', module: 'Admin', description: 'Create, edit, delete teams and assign members' },
  // Documentation Tracker
  { slug: 'doc:view',           module: 'Documentation', description: 'View documentation cases and documents' },
  { slug: 'doc:create',         module: 'Documentation', description: 'Create documentation tracking cases' },
  { slug: 'doc:edit',           module: 'Documentation', description: 'Edit documentation cases and documents' },
  { slug: 'doc:verify',         module: 'Documentation', description: 'Verify and approve documents' },
  { slug: 'doc:override',       module: 'Documentation', description: 'Override documentation completion requirements (manager)' },
  { slug: 'doc:transfer',       module: 'Documentation', description: 'Transfer documentation-ready cases to Process Department' },
  { slug: 'doc:preset:view',    module: 'Documentation', description: 'View document presets' },
  { slug: 'doc:preset:manage',  module: 'Documentation', description: 'Create, edit, and delete document presets' },
  { slug: 'doc:audit:view',     module: 'Documentation', description: 'View documentation audit timeline' },
] as const;

const PRESET_ROLES: Record<string, string[]> = {
  'Sales Manager': [
    'lead:view', 'lead:create', 'lead:edit', 'lead:delete', 'lead:assign',
    'contact:view', 'contact:create', 'contact:edit', 'contact:delete',
    'opportunity:view', 'opportunity:create', 'opportunity:edit', 'opportunity:delete',
    'activity:view', 'activity:create', 'activity:edit', 'activity:delete',
    'user:view', 'team:view', 'department:view',
  ],
  'Sales Executive': [
    'lead:view', 'lead:create', 'lead:edit',
    'contact:view', 'contact:create', 'contact:edit',
    'opportunity:view', 'opportunity:create', 'opportunity:edit',
    'activity:view', 'activity:create', 'activity:edit',
  ],
};

async function main(): Promise<void> {
  // ── Step 1: Upsert canonical permissions ──────────────────────────────────
  const createdPermissions: Array<{ id: string; slug: string }> = [];
  for (const perm of PERMISSIONS) {
    const p = await prisma.permission.upsert({
      where: { slug: perm.slug },
      create: perm,
      update: { module: perm.module, description: perm.description },
    });
    createdPermissions.push(p);
  }
  console.info(`✓ Seeded ${createdPermissions.length} permissions`);

  // ── Step 2: Determine which tenants exist ─────────────────────────────────
  const tenants = await prisma.tenant.findMany({ where: { deletedAt: null } });
  if (tenants.length === 0) {
    console.warn('⚠️  No tenants found. Skipping role seeding.');
    return;
  }
  console.info(`✓ Found ${tenants.length} tenant(s)`);

  const permBySlug = Object.fromEntries(createdPermissions.map(p => [p.slug, p]));

  // ── Step 3: Per tenant — upsert Organization Admin role + its permissions ─
  // DOES NOT assign any users; only configures the role definition.
  for (const tenant of tenants) {
    const adminRole = await prisma.role.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: 'Organization Admin' } },
      create: { tenantId: tenant.id, name: 'Organization Admin', isSystem: true },
      update: { isSystem: true, deletedAt: null },
    });

    // Full replace of admin role permissions (this is a system role — full reset is intentional)
    await prisma.rolePermission.deleteMany({ where: { roleId: adminRole.id } });
    await prisma.rolePermission.createMany({
      data: createdPermissions.map(p => ({ roleId: adminRole.id, permissionId: p.id })),
      skipDuplicates: true,
    });

    // ── Step 4: Upsert preset roles — additive only (no existing perms deleted) ─
    for (const [roleName, slugs] of Object.entries(PRESET_ROLES)) {
      const role = await prisma.role.upsert({
        where: { tenantId_name: { tenantId: tenant.id, name: roleName } },
        create: { tenantId: tenant.id, name: roleName },
        update: {},
      });
      const permIds = slugs.map(s => permBySlug[s]?.id).filter(Boolean) as string[];
      await prisma.rolePermission.createMany({
        data: permIds.map(pid => ({ roleId: role.id, permissionId: pid })),
        skipDuplicates: true,
      });
    }

    // Invalidate Redis cache for this tenant
    await permissionService.invalidatePermissionCache(tenant.id);
  }
  console.info(`✓ Organization Admin role configured for ${tenants.length} tenant(s)`);

  // ── Step 5: Assign Organization Admin to explicitly named users ───────────
  // Only runs if SEED_ADMIN_EMAILS is set. Skipped safely if not.
  const adminEmailsRaw = process.env.SEED_ADMIN_EMAILS ?? '';
  const adminEmails = adminEmailsRaw
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

  if (adminEmails.length === 0) {
    console.info('ℹ️  SEED_ADMIN_EMAILS not set — skipping user-role assignment.');
    console.info('   To assign Organization Admin: SEED_ADMIN_EMAILS=email@example.com npx tsx prisma/seed-permissions.ts');
    return;
  }

  let assignedCount = 0;
  for (const email of adminEmails) {
    const user = await prisma.user.findFirst({
      where: { email, deletedAt: null },
    });
    if (!user) {
      console.warn(`⚠️  User not found: ${email} — skipping`);
      continue;
    }

    const adminRole = await prisma.role.findFirst({
      where: { tenantId: user.tenantId, name: 'Organization Admin', deletedAt: null },
    });
    if (!adminRole) {
      console.warn(`⚠️  Organization Admin role missing for tenant of ${email} — skipping`);
      continue;
    }

    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
      create: { userId: user.id, roleId: adminRole.id, scopeType: ScopeType.ORGANIZATION },
      update: { scopeType: ScopeType.ORGANIZATION },
    });
    await permissionService.invalidatePermissionCache(user.tenantId);
    assignedCount++;
    console.info(`  ✓ Organization Admin assigned to ${email}`);
  }
  console.info(`✓ Admin role assigned to ${assignedCount}/${adminEmails.length} specified user(s)`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
