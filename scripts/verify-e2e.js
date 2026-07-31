const fs = require('fs');

async function verify() {
  console.log('1. Logging in as test@hpx.com');
  let res = await fetch('http://localhost:3000/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@hpx.com', password: 'password123' })
  });
  
  if (!res.ok) {
    const err = await res.text();
    console.error('Login failed:', res.status, err);
    process.exit(1);
  }
  
  const loginData = await res.json();
  const token = loginData.accessToken;
  const tenantId = loginData.tenantId;
  const userId = loginData.userId;
  console.log('Login successful. Token acquired.');

  console.log('\n2. Fetching departments to simulate Context switcher');
  res = await fetch('http://localhost:3000/api/v1/auth/me/departments', {
    headers: { 'Authorization': `Bearer ${token}`, 'x-tenant-id': tenantId }
  });
  
  if (!res.ok) {
    console.error('Failed to fetch departments:', res.status, await res.text());
    process.exit(1);
  }
  
  const depts = await res.json();
  const processDept = depts.find(d => d.name.toLowerCase().includes('process')) || depts[0];
  const docsDept = depts.find(d => d.name.toLowerCase().includes('doc')) || depts[0];
  
  if (!processDept || !docsDept) {
    console.error('Missing departments in test user context. Got:', depts.map(d => d.name));
  } else {
    console.log(`Found departments: Process (${processDept.id}), Docs (${docsDept.id})`);
  }

  const processDeptId = processDept?.id || '00000000-0000-0000-0000-000000000000';
  const docsDeptId = docsDept?.id || '00000000-0000-0000-0000-000000000000';

  console.log(`\n3. Navigating to Process department (UUID: ${processDeptId})`);
  res = await fetch('http://localhost:3000/api/v1/process/projects', {
    headers: { 
      'Authorization': `Bearer ${token}`, 
      'x-tenant-id': tenantId,
      'x-department-context': processDeptId
    }
  });
  console.log('GET /api/v1/process/projects -> Status:', res.status);
  console.log('Response:', await res.json());

  console.log(`\n4. Navigating to Docs department (UUID: ${docsDeptId})`);
  res = await fetch('http://localhost:3000/api/v1/docs/documents', {
    headers: { 
      'Authorization': `Bearer ${token}`, 
      'x-tenant-id': tenantId,
      'x-department-context': docsDeptId
    }
  });
  console.log('GET /api/v1/docs/documents -> Status:', res.status);
  console.log('Response:', await res.json());
}

verify().catch(console.error);
