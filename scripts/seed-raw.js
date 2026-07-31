const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function run() {
  try {
    const hash = await bcrypt.hash('password123', 12);
    
    // Clean up if exists
    await prisma.$executeRawUnsafe(`DELETE FROM "Identity" WHERE email = 'test@hpx.com'`);

    // Insert Identity
    const identity = await prisma.$queryRawUnsafe(`
      INSERT INTO "Identity" (id, email, "passwordHash", "emailVerified", "updatedAt") 
      VALUES (gen_random_uuid(), 'test@hpx.com', $1, now(), now()) 
      RETURNING id
    `, hash);
    const identityId = identity[0].id;

    // Ensure Tenant
    let tenant = await prisma.$queryRawUnsafe(`SELECT id FROM "Tenant" LIMIT 1`);
    if (!tenant.length) {
      tenant = await prisma.$queryRawUnsafe(`INSERT INTO "Tenant" (id, name, "updatedAt") VALUES (gen_random_uuid(), 'Test Co', now()) RETURNING id`);
    }
    const tenantId = tenant[0].id;

    // Insert User
    const user = await prisma.$queryRawUnsafe(`
      INSERT INTO "User" (id, "tenantId", "identityId", "updatedAt") 
      VALUES (gen_random_uuid(), $1::uuid, $2::uuid, now()) 
      RETURNING id
    `, tenantId, identityId);
    const userId = user[0].id;

    // OrganizationMembership
    const mem = await prisma.$queryRawUnsafe(`
      INSERT INTO "OrganizationMembership" (id, "identityId", "tenantId", "updatedAt") 
      VALUES (gen_random_uuid(), $1::uuid, $2::uuid, now()) 
      RETURNING id
    `, identityId, tenantId);

    // Department
    let dept = await prisma.$queryRawUnsafe(`SELECT id FROM "Department" WHERE "tenantId" = $1::uuid LIMIT 1`, tenantId);
    if (!dept.length) {
      dept = await prisma.$queryRawUnsafe(`
        INSERT INTO "Department" (id, "tenantId", name, "updatedAt") 
        VALUES (gen_random_uuid(), $1::uuid, 'Sales', now()) 
        RETURNING id
      `, tenantId);
    }
    const deptId = dept[0].id;

    // DepartmentAssignment
    await prisma.$queryRawUnsafe(`
      INSERT INTO "DepartmentAssignment" (id, "membershipId", "departmentId", "isPrimary") 
      VALUES (gen_random_uuid(), $1::uuid, $2::uuid, true)
    `, mem[0].id, deptId);

    // Ensure Process and Docs Departments exist for completeness
    let processDept = await prisma.$queryRawUnsafe(`SELECT id FROM "Department" WHERE "tenantId" = $1::uuid AND name = 'Process' LIMIT 1`, tenantId);
    if (!processDept.length) {
      processDept = await prisma.$queryRawUnsafe(`
        INSERT INTO "Department" (id, "tenantId", name, "updatedAt") 
        VALUES (gen_random_uuid(), $1::uuid, 'Process', now()) 
        RETURNING id
      `, tenantId);
    }
    
    let docsDept = await prisma.$queryRawUnsafe(`SELECT id FROM "Department" WHERE "tenantId" = $1::uuid AND name = 'Docs' LIMIT 1`, tenantId);
    if (!docsDept.length) {
      docsDept = await prisma.$queryRawUnsafe(`
        INSERT INTO "Department" (id, "tenantId", name, "updatedAt") 
        VALUES (gen_random_uuid(), $1::uuid, 'Docs', now()) 
        RETURNING id
      `, tenantId);
    }

    // Assign user to Process and Docs departments as well (so context switcher works properly in backend)
    await prisma.$queryRawUnsafe(`
      INSERT INTO "DepartmentAssignment" (id, "membershipId", "departmentId", "isPrimary") 
      VALUES (gen_random_uuid(), $1::uuid, $2::uuid, false)
      ON CONFLICT DO NOTHING
    `, mem[0].id, processDept[0].id);
    
    await prisma.$queryRawUnsafe(`
      INSERT INTO "DepartmentAssignment" (id, "membershipId", "departmentId", "isPrimary") 
      VALUES (gen_random_uuid(), $1::uuid, $2::uuid, false)
      ON CONFLICT DO NOTHING
    `, mem[0].id, docsDept[0].id);

    // Seed RBAC Permissions
    const permissions = [
      { slug: 'process:projects:read', module: 'Process', desc: 'Read projects' },
      { slug: 'process:projects:create', module: 'Process', desc: 'Create projects' },
      { slug: 'process:projects:update', module: 'Process', desc: 'Update projects' },
      { slug: 'process:projects:delete', module: 'Process', desc: 'Delete projects' },
      { slug: 'docs:documents:read', module: 'Docs', desc: 'Read documents' },
      { slug: 'docs:documents:create', module: 'Docs', desc: 'Create documents' },
      { slug: 'docs:documents:update', module: 'Docs', desc: 'Update documents' },
      { slug: 'docs:documents:delete', module: 'Docs', desc: 'Delete documents' }
    ];

    for (const p of permissions) {
      await prisma.$queryRawUnsafe(`
        INSERT INTO "Permission" (id, slug, module, description)
        VALUES (gen_random_uuid(), $1, $2, $3)
        ON CONFLICT (slug) DO NOTHING
      `, p.slug, p.module, p.desc);
    }

    // Create Roles
    let processRole = await prisma.$queryRawUnsafe(`SELECT id FROM "Role" WHERE "tenantId" = $1::uuid AND name = 'Process Admin' LIMIT 1`, tenantId);
    if (!processRole.length) {
      processRole = await prisma.$queryRawUnsafe(`
        INSERT INTO "Role" (id, "tenantId", name, "isSystem", "updatedAt") 
        VALUES (gen_random_uuid(), $1::uuid, 'Process Admin', false, now()) 
        RETURNING id
      `, tenantId);
    }
    const processRoleId = processRole[0].id;

    let docsRole = await prisma.$queryRawUnsafe(`SELECT id FROM "Role" WHERE "tenantId" = $1::uuid AND name = 'Docs Admin' LIMIT 1`, tenantId);
    if (!docsRole.length) {
      docsRole = await prisma.$queryRawUnsafe(`
        INSERT INTO "Role" (id, "tenantId", name, "isSystem", "updatedAt") 
        VALUES (gen_random_uuid(), $1::uuid, 'Docs Admin', false, now()) 
        RETURNING id
      `, tenantId);
    }
    const docsRoleId = docsRole[0].id;

    // Link Permissions to Roles
    await prisma.$executeRawUnsafe(`
      INSERT INTO "RolePermission" ("roleId", "permissionId")
      SELECT $1::uuid, id FROM "Permission" WHERE module = 'Process'
      ON CONFLICT DO NOTHING
    `, processRoleId);

    await prisma.$executeRawUnsafe(`
      INSERT INTO "RolePermission" ("roleId", "permissionId")
      SELECT $1::uuid, id FROM "Permission" WHERE module = 'Docs'
      ON CONFLICT DO NOTHING
    `, docsRoleId);

    // Assign Roles to User
    await prisma.$executeRawUnsafe(`
      INSERT INTO "UserRole" ("userId", "roleId", "scopeType")
      VALUES ($1::uuid, $2::uuid, 'DEPARTMENT'::"ScopeType")
      ON CONFLICT DO NOTHING
    `, userId, processRoleId);

    await prisma.$executeRawUnsafe(`
      INSERT INTO "UserRole" ("userId", "roleId", "scopeType")
      VALUES ($1::uuid, $2::uuid, 'DEPARTMENT'::"ScopeType")
      ON CONFLICT DO NOTHING
    `, userId, docsRoleId);

    console.log('User seeded successfully with RBAC roles and permissions');
  } catch (e) {
    console.error('Error seeding user:', e);
  } finally {
    await prisma.$disconnect();
  }
}

run();
