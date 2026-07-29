import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding E2E database...');
  // The system uses seed data to ensure determinism.
  // We don't want to create users here because the suite tests the entire
  // signup -> verify -> login flow which will organically populate the DB.
  // Instead, we just seed required system primitives (like default permissions/roles if any).
  
  const permissions = [
    { name: 'VIEW_USERS', description: 'Can view users' },
    { name: 'MANAGE_USERS', description: 'Can manage users' }
  ];

  for (const perm of permissions) {
    await prisma.permission.upsert({
      where: { name: perm.name },
      update: {},
      create: perm
    });
  }

  console.log('E2E seeding complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
