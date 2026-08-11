/**
 * Permission & Super Admin Seeding Script
 * Restores canonical permissions, Organization Admin role, and Super Admin user assignments.
 * Invalidates Redis permission version cache to prevent stale cache lockouts.
 * Run locally or in deployment shell: npx tsx prisma/seed-permissions.ts
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

async function main(): Promise<void> {
  // Step 1: Seed the 33 canonical permissions
  const createdPermissions = [];
  for (const perm of PERMISSIONS) {
    const p = await prisma.permission.upsert({
      where: { slug: perm.slug },
      create: perm,
      update: { module: perm.module, description: perm.description },
    });
    createdPermissions.push(p);
  }
  console.info(`✓ Seeded ${createdPermissions.length} permissions`);

  // Step 2: Find ALL Users in the database
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
  });

  if (users.length === 0) {
    console.warn('⚠️ Warning: No users found in database. Exiting seed script.');
    return;
  }

  // Step 3 & 4 & 5 & 6: For EACH user, upsert the role, map permissions, and assign to user
  let updatedCount = 0;
  for (const user of users) {
    // Upsert an "Organization Admin" Role for the user's tenant
    const role = await prisma.role.upsert({
      where: {
        tenantId_name: {
          tenantId: user.tenantId,
          name: 'Organization Admin',
        },
      },
      create: {
        tenantId: user.tenantId,
        name: 'Organization Admin',
        isSystem: true,
      },
      update: {
        isSystem: true,
        deletedAt: null,
      },
    });

    // Delete all existing RolePermission records for this Role, then recreate them
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id },
    });

    await prisma.rolePermission.createMany({
      data: createdPermissions.map((perm) => ({
        roleId: role.id,
        permissionId: perm.id,
      })),
      skipDuplicates: true,
    });

    // Upsert a UserRole record linking User to "Organization Admin" Role
    await prisma.userRole.upsert({
      where: {
        userId_roleId: {
          userId: user.id,
          roleId: role.id,
        },
      },
      create: {
        userId: user.id,
        roleId: role.id,
        scopeType: ScopeType.ORGANIZATION,
      },
      update: {
        scopeType: ScopeType.ORGANIZATION,
      },
    });

    // Invalidate Redis permission version cache
    await permissionService.invalidatePermissionCache(user.tenantId);
    
    updatedCount++;
  }

  // Step 7: Seed preset roles (Sales Manager, Sales Executive) per tenant
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

  const permBySlug = Object.fromEntries(createdPermissions.map(p => [p.slug, p]));
  const tenantIds = [...new Set(users.map(u => u.tenantId))];

  for (const tenantId of tenantIds) {
    for (const [roleName, slugs] of Object.entries(PRESET_ROLES)) {
      const role = await prisma.role.upsert({
        where: { tenantId_name: { tenantId, name: roleName } },
        create: { tenantId, name: roleName },
        update: {},
      });

      const permIds = slugs.map(s => permBySlug[s]?.id).filter(Boolean) as string[];
      await prisma.rolePermission.createMany({
        data: permIds.map(pid => ({ roleId: role.id, permissionId: pid })),
        skipDuplicates: true,
      });
    }
  }
  console.info(`✓ Preset roles seeded for ${tenantIds.length} tenant(s).`);

  // Step 8: Log success message
  console.info(`✓ Super Admin access restored for ${updatedCount} users.`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
