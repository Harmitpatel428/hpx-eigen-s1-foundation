import { PrismaClient, AssignmentType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const isExecute = args.includes('--execute');
  const isValidate = args.includes('--validate');
  const isDryRun = !isExecute && !isValidate;

  console.log(`[MIGRATION] Mode: ${isExecute ? 'EXECUTE' : isValidate ? 'VALIDATE' : 'DRY-RUN'}`);

  if (isValidate) {
    await validateParity();
    return;
  }

  console.log(`[MIGRATION] Fetching v1 Users and UserRoles...`);
  const users = await prisma.user.findMany({
    include: {
      userRoles: true
    }
  });
  console.log(`[MIGRATION] Found ${users.length} v1 Users.`);

  if (isDryRun) {
    let identityCount = 0;
    let membershipCount = 0;
    let assignmentCount = 0;
    let membershipRoleCount = 0;

    for (const user of users) {
      identityCount++;
      membershipCount++;
      if (user.departmentId) assignmentCount++;
      if (user.teamId) assignmentCount++;
      membershipRoleCount += user.userRoles.length;
    }
    
    console.log(`[DRY-RUN] Mapping Simulation:`);
    console.log(`- Would create ${identityCount} Identities.`);
    console.log(`- Would create ${membershipCount} OrganizationMemberships.`);
    console.log(`- Would create ${assignmentCount} Assignments.`);
    console.log(`- Would create ${membershipRoleCount} MembershipRoles.`);
    
    console.log(`[DRY-RUN] Parity Check (Simulated):`);
    console.log(`- v1 Users: ${users.length} == v2 Identities: ${identityCount} -> ${users.length === identityCount ? 'PASS' : 'FAIL'}`);
    
    const totalV1Roles = users.reduce((acc, u) => acc + u.userRoles.length, 0);
    console.log(`- v1 UserRoles: ${totalV1Roles} == v2 MembershipRoles: ${membershipRoleCount} -> ${totalV1Roles === membershipRoleCount ? 'PASS' : 'FAIL'}`);

    if (users.length !== identityCount || totalV1Roles !== membershipRoleCount) {
      process.exit(1);
    }
    
    console.log(`[DRY-RUN] Dry run complete. Use --execute to run the actual migration.`);
    return;
  }

  if (isExecute) {
    console.log(`[EXECUTE] Beginning data migration...`);
    
    await prisma.$transaction(async (tx) => {
      let processed = 0;
      for (const user of users) {
        // Step B: Upsert Identity
        const identity = await tx.identity.upsert({
          where: { email: user.email },
          update: {},
          create: {
            email: user.email,
            passwordHash: user.password,
            globalStatus: 'ACTIVE',
            emailVerified: user.emailVerified
          }
        });

        // Step C: Upsert OrganizationMembership
        const membership = await tx.organizationMembership.upsert({
          where: {
            identityId_tenantId: {
              identityId: identity.id,
              tenantId: user.tenantId
            }
          },
          update: {},
          create: {
            identityId: identity.id,
            tenantId: user.tenantId,
            status: 'ACTIVE'
          }
        });

        // Step D: Map Department Assignment
        if (user.departmentId) {
          const existingDept = await tx.assignment.findFirst({
            where: {
              membershipId: membership.id,
              assignmentType: 'DEPARTMENT',
              targetId: user.departmentId
            }
          });
          if (!existingDept) {
            await tx.assignment.create({
              data: {
                membershipId: membership.id,
                assignmentType: 'DEPARTMENT',
                targetId: user.departmentId,
                isPrimary: true
              }
            });
          }
        }

        // Step E: Map Team Assignment
        if (user.teamId) {
          const existingTeam = await tx.assignment.findFirst({
            where: {
              membershipId: membership.id,
              assignmentType: 'TEAM',
              targetId: user.teamId
            }
          });
          if (!existingTeam) {
            await tx.assignment.create({
              data: {
                membershipId: membership.id,
                assignmentType: 'TEAM',
                targetId: user.teamId,
                isPrimary: true
              }
            });
          }
        }

        // Step F & G: Map MembershipRoles
        for (const role of user.userRoles) {
          await tx.membershipRole.upsert({
            where: {
              membershipId_roleId: {
                membershipId: membership.id,
                roleId: role.roleId
              }
            },
            update: {
              scopeType: role.scopeType
            },
            create: {
              membershipId: membership.id,
              roleId: role.roleId,
              scopeType: role.scopeType
            }
          });
        }
        
        // Link User to new entities for dual-write compatibility tracking
        await tx.user.update({
          where: { id: user.id },
          data: {
            v2IdentityId: identity.id,
            v2MembershipId: membership.id,
            v2MigrationStatus: 'BACKFILLED'
          }
        });

        processed++;
        if (processed % 100 === 0) {
          console.log(`[EXECUTE] Processed ${processed}/${users.length} users...`);
        }
      }
    }, {
      timeout: 300000 // 5 minutes timeout for large datasets
    });
    
    console.log(`[EXECUTE] Migration completed successfully.`);
    await validateParity();
  }
}

async function validateParity() {
  console.log(`[VALIDATION] Running Database Parity Check...`);
  const v1UserCount = await prisma.user.count();
  const v2IdentityCount = await prisma.identity.count();
  
  const v1RoleCount = await prisma.userRole.count();
  const v2RoleCount = await prisma.membershipRole.count();
  
  console.log(`- v1 Users: ${v1UserCount} | v2 Identities: ${v2IdentityCount}`);
  console.log(`- v1 UserRoles: ${v1RoleCount} | v2 MembershipRoles: ${v2RoleCount}`);
  
  if (v1UserCount !== v2IdentityCount) {
    console.error(`[ERROR] User count mismatch!`);
    process.exit(1);
  }
  
  if (v1RoleCount !== v2RoleCount) {
    console.error(`[ERROR] Role count mismatch!`);
    process.exit(1);
  }
  
  console.log(`[VALIDATION] PASS! Database parity is 100%.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
