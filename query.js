const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const tenants = await prisma.tenant.findMany();
  console.log("Tenants:", tenants);
  const users = await prisma.user.findMany();
  console.log("Users:", users);
}

main().catch(console.error).finally(() => prisma.$disconnect());
