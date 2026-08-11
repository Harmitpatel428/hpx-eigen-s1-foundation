import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.error(
      '❌ SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD env vars are required.\n' +
      '   Never commit credentials. Set these in your shell before running.'
    );
    process.exit(1);
  }

  if (adminPassword.length < 12) {
    console.error('❌ SEED_ADMIN_PASSWORD must be at least 12 characters.');
    process.exit(1);
  }

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

  const hashedPassword = await bcrypt.hash(adminPassword, 12);

  const user = await prisma.user.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    update: {
      email: adminEmail,
      password: hashedPassword,
      status: 'ACTIVE',
      emailVerified: new Date(),
      departmentId: dept.id,
      teamId: team.id,
    },
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      email: adminEmail,
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
