// @ts-nocheck
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting backfill...');
  
  // 1. Backfill Identities for existing users
  const users: any[] = await prisma.$queryRaw`SELECT id, "tenantId" FROM "User" WHERE "identityId" IS NULL`;
  
  console.log(`Found ${users.length} users to migrate to identities.`);
  
  for (const user of users) {
    const newIdentity = await prisma.identity.create({
      data: {
        email: `migrated_${user.id}@example.com`,
        passwordHash: 'dummy_hash',
        globalStatus: 'ACTIVE'
      }
    });
    
    // Update User with identityId
    await prisma.$executeRaw`UPDATE "User" SET "identityId" = ${newIdentity.id}::uuid WHERE id = ${user.id}::uuid`;
  }
  
  // 2. Backfill Departments for CRM objects
  const tenants = await prisma.tenant.findMany({
    select: { id: true }
  });
  
  for (const tenant of tenants) {
    const firstDept = await prisma.department.findFirst({
      where: { tenantId: tenant.id }
    });
    
    if (!firstDept) continue;
    
    console.log(`Updating CRM objects for tenant ${tenant.id} with department ${firstDept.id}`);
    
    await prisma.lead.updateMany({
      where: { tenantId: tenant.id, departmentId: null },
      data: { departmentId: firstDept.id }
    });
    
    await prisma.contact.updateMany({
      where: { tenantId: tenant.id, departmentId: null },
      data: { departmentId: firstDept.id }
    });
    
    await prisma.opportunity.updateMany({
      where: { tenantId: tenant.id, departmentId: null },
      data: { departmentId: firstDept.id }
    });
  }
  
  // 3. Fix null ownerIds
  for (const tenant of tenants) {
    const defaultUser = await prisma.identity.findFirst({
      where: { tenantId: tenant.id }
    });
    
    if (defaultUser) {
      await prisma.lead.updateMany({
        where: { tenantId: tenant.id, ownerId: null },
        data: { ownerId: defaultUser.id }
      });
      await prisma.contact.updateMany({
        where: { tenantId: tenant.id, ownerId: null },
        data: { ownerId: defaultUser.id }
      });
    }
  }

  console.log('Backfill completed safely.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
