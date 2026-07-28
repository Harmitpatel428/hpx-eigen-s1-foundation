import { PrismaClient } from '@prisma/client';
import { PermissionService } from '../src/services/permission.service';
import { redisGet, redisKeys } from '../src/redis';

const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);

async function diagnose() {
  console.log('====================================================');
  console.log('DIAGNOSTIC START: PERMISSION MAPPING & REDIS CACHE');
  console.log('====================================================\n');

  // Find first user
  const user = await prisma.user.findFirst({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    include: { tenant: true },
  });

  if (!user) {
    console.error('❌ No user found in database!');
    return;
  }

  console.log(`👤 Target User: ${user.email} (ID: ${user.id})`);
  console.log(`🏢 Tenant: ${user.tenant.name} (ID: ${user.tenantId})\n`);

  // a) Raw UserRole records for that user
  const userRoles = await prisma.userRole.findMany({
    where: { userId: user.id },
    include: { role: true },
  });
  console.log('--- [a] RAW USER ROLE RECORDS ---');
  console.log(JSON.stringify(userRoles, null, 2));
  console.log(`Total UserRoles found: ${userRoles.length}\n`);

  // b) Raw RolePermission records for those roles
  const roleIds = userRoles.map((ur) => ur.roleId);
  const rolePermissions = await prisma.rolePermission.findMany({
    where: { roleId: { in: roleIds } },
    include: { permission: true },
  });
  console.log('--- [b] RAW ROLE PERMISSION RECORDS ---');
  console.log(JSON.stringify(rolePermissions, null, 2));
  console.log(`Total RolePermissions mapped: ${rolePermissions.length}\n`);

  // c) Compiled manifest by calling PermissionService._buildV1ManifestFromDB directly (bypassing Redis)
  const dbManifest = await (permissionService as any)._buildV1ManifestFromDB(user.id, user.tenantId);
  console.log('--- [c] COMPILED MANIFEST FROM DB (Bypassing Redis) ---');
  console.log(JSON.stringify(dbManifest, null, 2));
  console.log(`Total permissions in DB manifest: ${Object.keys(dbManifest).length}\n`);

  // Check Redis state
  const versionKey = redisKeys.permVersion(user.tenantId);
  const rawVersion = await redisGet(versionKey);
  console.log(`ℹ️ Current Redis perm_version key (${versionKey}): ${rawVersion}`);

  if (rawVersion) {
    const userPermsKey = redisKeys.userPerms(user.tenantId, user.id, parseInt(rawVersion, 10));
    const cachedVal = await redisGet(userPermsKey);
    console.log(`ℹ️ Cached Redis user perms key (${userPermsKey}): ${cachedVal}`);
  }

  // d) Compiled manifest by calling PermissionService.getPermissionManifest (hitting Redis)
  const cachedManifest = await permissionService.getPermissionManifest(user.id, user.tenantId);
  console.log('\n--- [d] COMPILED MANIFEST FROM SERVICE (Hitting Redis) ---');
  console.log(JSON.stringify(cachedManifest, null, 2));
  console.log(`Total permissions in Service manifest: ${Object.keys(cachedManifest).length}\n`);

  console.log('====================================================');
  console.log('DIAGNOSTIC SUMMARY');
  console.log('====================================================');
  console.log(`DB Manifest count:      ${Object.keys(dbManifest).length}`);
  console.log(`Service Manifest count: ${Object.keys(cachedManifest).length}`);

  if (Object.keys(dbManifest).length > 0 && Object.keys(cachedManifest).length === 0) {
    console.log('🚨 PROVEN: REDIS CACHE POISONING! DB has permissions, but Redis returns empty manifest.');
  } else if (Object.keys(dbManifest).length === 0) {
    console.log('🚨 PROVEN: DB MAPPING FAILURE! Database has 0 permissions for this user.');
  } else {
    console.log('✅ BOTH MATCH: Database and Redis manifests match.');
  }
}

diagnose()
  .catch((err) => {
    console.error('Diagnostic error:', err);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
