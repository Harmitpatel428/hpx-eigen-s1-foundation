import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.findFirst();
  if (!tenant) {
    console.error('❌ No tenant found. Create a tenant first.');
    process.exit(1);
  }

  const departments = ['Sales', 'Process', 'Documentation'];

  for (const name of departments) {
    const existing = await prisma.department.findFirst({
      where: {
        tenantId: tenant.id,
        name: name,
      }
    });

    if (!existing) {
      await prisma.department.create({
        data: {
          name: name,
          tenantId: tenant.id,
        },
      });
      console.log(`✅ Department created: ${name}`);
    } else {
      console.log(`✅ Department already exists: ${name}`);
    }
  }

  console.log('🎉 All departments seeded.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
