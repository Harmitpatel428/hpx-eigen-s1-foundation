import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const API_URL = 'http://localhost:3001/api';

async function main() {
  const timestamp = Math.floor(Date.now() / 1000);
  const email = `e2e-${timestamp}@example.com`;
  const password = 'TestPassword123!';
  const companyName = 'Test E2E Inc';

  console.log(`\n--- E2E Flow Test ---`);
  console.log(`1. Signup: ${email}`);

  let res = await fetch(`${API_URL}/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, companyName })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('Signup failed:', text);
    process.exit(1);
  }
  console.log('Signup success.');

  console.log(`2. Waiting briefly for token to be created in DB...`);
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log(`3. Retrieving verification token from DB...`);
  const user = await prisma.user.findFirst({ where: { email } });
  if (!user) throw new Error('User not found in DB after signup');

  const vt = await prisma.verificationToken.findFirst({ where: { userId: user.id } });
  if (!vt) throw new Error('Verification token not found in DB');
  
  // @ts-ignore - token might be present in the model
  const tokenString = vt.token; 
  if (!tokenString) throw new Error('Raw token string not found in DB row');

  console.log('Token retrieved. Calling verify endpoint...');
  
  res = await fetch(`${API_URL}/v1/auth/verify-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tokenString })
  });

  if (!res.ok) {
    console.error('Verify failed:', await res.text());
    process.exit(1);
  }
  
  console.log('Verify success:', await res.json());

  // Check DB
  const verifiedUser = await prisma.user.findFirst({ where: { email } });
  if (!verifiedUser?.emailVerified) throw new Error('emailVerified not set in DB');
  console.log(`DB Checked: emailVerified = ${verifiedUser.emailVerified}`);

  const usedToken = await prisma.verificationToken.findFirst({ where: { id: vt.id } });
  if (usedToken?.status !== 'USED') throw new Error('Token not marked as USED');
  console.log(`DB Checked: Token status = ${usedToken.status}`);

  console.log(`4. Login...`);
  res = await fetch(`${API_URL}/v1/auth/login`, {
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
  console.log('Login success. JWT received.');

  console.log(`5. Logout...`);
  res = await fetch(`${API_URL}/v1/auth/logout`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${jwt}` }
  });

  if (!res.ok) {
    console.error('Logout failed:', await res.text());
    process.exit(1);
  }
  console.log('Logout success.');

  console.log(`6. Login Again...`);
  res = await fetch(`${API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });

  if (!res.ok) {
    console.error('Login 2 failed:', await res.text());
    process.exit(1);
  }
  console.log('Login 2 success. E2E FLOW PASSED.');
}

main().finally(() => prisma.$disconnect());
