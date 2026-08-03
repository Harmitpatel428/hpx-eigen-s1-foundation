import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function run() {
  // Query Identity (if it exists)
  try {
    const identity = (await (prisma as any).identity?.findUnique({ where: { email: 'test@hpx.com' } })) || null;
    if (identity) {
      console.log('--- IDENTITY DUMP ---');
      console.log(JSON.stringify({
        id: identity.id,
        email: identity.email,
        passwordHash: identity.passwordHash,
        emailVerified: identity.emailVerified,
        globalStatus: identity.globalStatus
      }, null, 2));

      console.log('--- HASH COMPARISON ---');
      console.log('Hash from DB:', identity.passwordHash);
      const isMatch = await bcrypt.compare('password123', identity.passwordHash);
      console.log('Manual bcrypt match result:', isMatch);
    } else {
      console.log('IDENTITY NOT FOUND FOR test@hpx.com');
    }
  } catch (e) {
    console.log('Identity table might not exist or error:', (e as Error).message);
  }

  // Query User
  try {
    const user = await prisma.user.findFirst({ where: { email: 'test@hpx.com' } });
    console.log('--- USER DUMP ---');
    if (user) {
      console.log(JSON.stringify({
        id: user.id,
        email: user.email,
        tenantId: user.tenantId,
        status: user.status,
        departmentId: (user as any).departmentId,
        emailVerified: (user as any).emailVerified,
        password: (user as any).password
      }, null, 2));
      
      if ((user as any).password) {
        console.log('--- HASH COMPARISON (USER TABLE) ---');
        console.log('Hash from DB:', (user as any).password);
        const isMatchUser = await bcrypt.compare('password123', (user as any).password);
        console.log('Manual bcrypt match result:', isMatchUser);
      }
    } else {
      console.log('USER MISSING: test@hpx.com NOT FOUND IN USER TABLE');
    }
  } catch (e) {
    console.log('User error:', (e as Error).message);
  }
}

run().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
