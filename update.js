const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  await prisma.tenant.update({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    data: { name: 'HPX-EIGEN' }
  });
  console.log("Updated tenant to HPX-EIGEN");
}

main().catch(console.error).finally(() => prisma.$disconnect());
