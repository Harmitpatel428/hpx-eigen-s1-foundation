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
  { slug: 'user:view',   module: 'Admin', description: 'View users' },
  { slug: 'user:manage', module: 'Admin', description: 'Invite, suspend, and manage users' },
  // Departments & Teams
  { slug: 'department:view',   module: 'Admin', description: 'View departments' },
  { slug: 'department:manage', module: 'Admin', description: 'Create, edit, delete departments' },
  { slug: 'team:view',   module: 'Admin', description: 'View teams' },
  { slug: 'team:manage', module: 'Admin', description: 'Create, edit, delete teams and assign members' },
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

  // Step 2: Find the first Tenant in the database
  const tenant = await prisma.tenant.findFirst({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });

  if (!tenant) {
    console.warn('⚠️ Warning: No tenant found in database. Exiting seed script.');
    return;
  }

  // Step 3: Upsert an "Organization Admin" Role for that tenant
  const role = await prisma.role.upsert({
    where: {
      tenantId_name: {
        tenantId: tenant.id,
        name: 'Organization Admin',
      },
    },
    create: {
      tenantId: tenant.id,
      name: 'Organization Admin',
      isSystem: true,
    },
    update: {
      isSystem: true,
      deletedAt: null,
    },
  });
  console.info(`✓ Upserted "Organization Admin" Role (ID: ${role.id})`);

  // Step 4: Delete all existing RolePermission records for this Role, then recreate them
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
  console.info(`✓ Mapped ${createdPermissions.length} permissions to "Organization Admin" role`);

  // Step 5: Find the first User in that tenant
  const user = await prisma.user.findFirst({
    where: { tenantId: tenant.id, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });

  if (!user) {
    console.warn('⚠️ Warning: No user found in tenant. Exiting seed script.');
    return;
  }

  // Step 6: Upsert a UserRole record linking User to "Organization Admin" Role with scopeType: 'ORGANIZATION'
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

  // Invalidate Redis permission version cache to clear stale empty manifest for this tenant
  await permissionService.invalidatePermissionCache(tenant.id);
  console.info(`✓ Invalidated Redis permission cache for tenant: ${tenant.id}`);

  // Step 7: Log success message
  console.info(`✓ Super Admin access restored for ${user.email}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
