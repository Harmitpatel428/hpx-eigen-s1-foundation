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

  // Create default department + team
  const dept = await prisma.department.upsert({
    where: { id: '00000000-0000-0000-0000-000000000003' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000003',
      tenantId: tenant.id,
      name: 'Sales',
    },
  });

  const team = await prisma.team.upsert({
    where: { id: '00000000-0000-0000-0000-000000000004' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000004',
      tenantId: tenant.id,
      departmentId: dept.id,
      name: 'Default Team',
    },
  });

  // Hash password
  const hashedPassword = await bcrypt.hash('Anil@404', 12);

  // Create admin user
  const user = await prisma.user.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    update: {
      email: 'anil@v4ubizsolutions.com',
      password: hashedPassword,
      status: 'ACTIVE',
      emailVerified: new Date(),
      departmentId: dept.id,
      teamId: team.id,
    },
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      email: 'anil@v4ubizsolutions.com',
      password: hashedPassword,
      tenantId: tenant.id,
      status: 'ACTIVE',
      emailVerified: new Date(),
      departmentId: dept.id,
      teamId: team.id,
    },
  });

  console.log('✅ Admin user created:', user.email);
  console.log('✅ Department:', dept.name, '| Team:', team.name);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
