import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const API_URL = 'http://localhost:3001/api';

async function main() {
  const email = 'e2e-1785996721@example.com';
  const password = 'TestPassword123!';

  console.log(`\n--- Backward Compatibility Test ---`);
  
  // Verify the user manually in DB
  const user = await prisma.user.updateMany({
    where: { email },
    data: { emailVerified: new Date() }
  });
  
  console.log(`User ${email} verified in DB.`);

  console.log(`Testing Login for existing verified user...`);
  const res = await fetch(`${API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });

  if (!res.ok) {
    console.error('Login failed:', await res.text());
    process.exit(1);
  }

  const loginData: any = await res.json();
  const jwt = loginData.jwt;
  if (!jwt) throw new Error('No JWT returned');
  
  console.log('Login success for pre-existing user. JWT received.');
  console.log('BACKWARD COMPATIBILITY PASSED.');
}

main().finally(() => prisma.$disconnect());
