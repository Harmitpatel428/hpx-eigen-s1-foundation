import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Create tenant
  const tenant = await prisma.tenant.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Test Tenant',
    },
  });

  // Hash password
  const hashedPassword = await bcrypt.hash('password123', 12);

  // Create test user
  const user = await prisma.user.upsert({
    where: { 
      tenantId_email: {
        tenantId: tenant.id,
        email: 'test@example.com'
      }
    },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      email: 'test@example.com',
      password: hashedPassword,
      tenantId: tenant.id,
      status: 'ACTIVE',
    },
  });

  console.log('✅ Test user created:', user.email);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
