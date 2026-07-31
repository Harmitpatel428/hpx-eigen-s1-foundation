// @ts-nocheck — written against pre-Phase-1 schema; superseded by seed-raw.js
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = 'test@hpx.com';
  const password = 'password123';
  
  // Hash password
  const passwordHash = await bcrypt.hash(password, 12);
  
  // 1. Create or find Identity
  let identity = await prisma.identity.findUnique({
    where: { email }
  });
  
  if (!identity) {
    identity = await prisma.identity.create({
      data: {
        email,
        passwordHash,
        emailVerified: new Date()
      }
    });
    console.log('Created Identity:', identity.id);
  } else {
    // Update password just in case
    identity = await prisma.identity.update({
      where: { id: identity.id },
      data: { passwordHash }
    });
    console.log('Updated Identity:', identity.id);
  }

  // 2. Ensure Tenant exists
  let tenant = await prisma.tenant.findFirst();
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: { name: 'Test Tenant' }
    });
    console.log('Created Tenant:', tenant.id);
  }

  // 3. Ensure Department exists
  let department = await prisma.department.findFirst({
    where: { tenantId: tenant.id }
  });
  if (!department) {
    department = await prisma.department.create({
      data: {
        tenantId: tenant.id,
        name: 'Sales',
        isDefault: true
      }
    });
    console.log('Created Department:', department.id);
  }

  // 4. Ensure User exists and is linked
  let user = await prisma.user.findFirst({
    where: { identityId: identity.id, tenantId: tenant.id }
  });
  
  if (!user) {
    user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        identityId: identity.id,
        status: 'ACTIVE'
      }
    });
    console.log('Created User:', user.id);
  } else {
    console.log('Found existing User:', user.id);
  }

  // 5. Ensure DepartmentAssignment exists
  const assignment = await prisma.departmentAssignment.findUnique({
    where: {
      userId_departmentId: {
        userId: user.id,
        departmentId: department.id
      }
    }
  });

  if (!assignment) {
    await prisma.departmentAssignment.create({
      data: {
        userId: user.id,
        departmentId: department.id,
        isPrimary: true
      }
    });
    console.log('Created DepartmentAssignment');
  }

  console.log('Test user ready. You can login with test@hpx.com / password123');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
