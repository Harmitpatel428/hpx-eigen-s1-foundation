/**
 * Permission Seed Script
 * Populates the global Permission table with canonical slugs.
 * Run once after migration: npx ts-node prisma/seed-permissions.ts
 * or add to package.json scripts and run: npx prisma db seed
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
  let upserted = 0;
  for (const perm of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { slug: perm.slug },
      create: perm,
      update: { module: perm.module, description: perm.description },
    });
    upserted++;
  }
  console.info(`✓ Seeded ${upserted} permissions`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
