import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('Testing Verify Email Transaction...');
  
  const token = 'test-token-' + Date.now();
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  
  // Create a dummy user
  const user = await prisma.user.create({
    data: {
      email: `test-${Date.now()}@example.com`,
      password: 'hash',
      tenantId: 'd6b9d6a3-67c4-4d8e-9d8a-356c3f68d712', // using any valid tenant, or create one
      emailVerified: null
    }
  }).catch(async () => {
    // create tenant first
    const t = await prisma.tenant.create({ data: { name: 'test' }});
    return prisma.user.create({
      data: {
        email: `test-${Date.now()}@example.com`,
        password: 'hash',
        tenantId: t.id,
        emailVerified: null
      }
    });
  });
  
  console.log('User created:', user.id);
  
  const vt = await prisma.verificationToken.create({
    data: {
      userId: user.id,
      token: token,
      tokenHash: tokenHash,
      expiresAt: new Date(Date.now() + 86400000)
    }
  });
  console.log('Token created:', vt.id);
  
  // Now simulate the verify-email logic
  const verificationToken = await prisma.verificationToken.findFirst({
    where: { tokenHash, status: 'PENDING' }
  });
  
  if (verificationToken) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id: verificationToken.userId },
          data: { emailVerified: new Date(), verifiedAt: new Date() }
        });
        await tx.verificationToken.update({
          where: { id: verificationToken.id },
          data: { status: 'USED', usedAt: new Date(), deletedAt: new Date() }
        });
        return u;
      });
      console.log('Transaction succeeded. emailVerified:', result.emailVerified);
    } catch (e) {
      console.error('Transaction failed!', e);
    }
  }
}

main().finally(() => prisma.$disconnect());
