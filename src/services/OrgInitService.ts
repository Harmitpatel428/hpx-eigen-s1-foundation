import { PrismaClient, ScopeType } from '@prisma/client';
import crypto from 'crypto';

export type InitializeOrgRBACResult = {
  departmentId: string;
  teamId: string;
  roleId: string;
  success: true;
} | {
  error: string;
  code: string;
  success: false;
};

export class OrgInitService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Initializes the RBAC structure for a new organization (Tenant) in a single transaction.
   *
   * @param tenantId The UUID of the newly created Tenant
   * @param userId The UUID of the newly created User
   * @param departmentName Optional custom department name (defaults to "Administration")
   * @param teamName Optional custom team name (defaults to "Admin")
   * @returns InitializeOrgRBACResult
   */
  async initializeOrgRBAC(
    tenantId: string,
    userId: string,
    departmentName: string = "Administration",
    teamName: string = "Admin"
  ): Promise<InitializeOrgRBACResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Create Department (root admin dept)
        const department = await tx.department.create({
          data: {
            tenantId,
            name: departmentName,
          }
        });

        // 2. Create Team (root admin team, link to dept)
        const team = await tx.team.create({
          data: {
            tenantId,
            departmentId: department.id,
            name: teamName,
          }
        });

        // 3. Create Role (Organization Administrator)
        const role = await tx.role.create({
          data: {
            tenantId,
            name: 'Organization Administrator',
            isSystem: true,
          }
        });

        // 4. Query all Permissions
        const allPermissions = await tx.permission.findMany();

        // 5. Create RolePermission mappings
        if (allPermissions.length > 0) {
          await tx.rolePermission.createMany({
            data: allPermissions.map(p => ({
              roleId: role.id,
              permissionId: p.id
            }))
          });
        }

        // 6. Create UserRole
        const userRole = await tx.userRole.create({
          data: {
            userId,
            roleId: role.id,
            scopeType: ScopeType.ORGANIZATION,
          }
        });

        // 7. Update User with departmentId and teamId
        await tx.user.update({
          where: { id: userId },
          data: {
            departmentId: department.id,
            teamId: team.id,
          }
        });

        // 8. Create immutable AuditLog entries (SHA-256 hash chained)
        const generateHash = (eventData: any, previousHash: string | null) => {
          return crypto.createHash('sha256').update(JSON.stringify(eventData) + (previousHash || '')).digest('hex');
        };

        const createAuditLog = async (
          eventType: string,
          entityType: string,
          entityId: string,
          operation: string,
          payload: any,
          previousHash: string | null
        ) => {
          const currentHash = generateHash({ eventType, entityType, entityId, operation, payload }, previousHash);
          return await tx.auditLog.create({
            data: {
              tenantId,
              eventType,
              entityType,
              entityId,
              actorUserId: userId,
              actorIp: '0.0.0.0',
              actorUserAgent: 'hpx-eigen-api',
              operation,
              payload,
              previousHash,
              currentHash,
            }
          });
        };

        // Entry 1
        const audit1 = await createAuditLog(
          "department_created", "Department", department.id, "CREATE", { name: departmentName }, null
        );

        // Entry 2
        const audit2 = await createAuditLog(
          "team_created", "Team", team.id, "CREATE", { name: teamName, departmentId: department.id }, audit1.currentHash
        );

        // Entry 3
        const audit3 = await createAuditLog(
          "role_created", "Role", role.id, "CREATE", { name: "Organization Administrator", level: "ORGANIZATION" }, audit2.currentHash
        );

        // Entry 4
        const audit4 = await createAuditLog(
          "role_assigned", "UserRole", `${userId}_${role.id}`, "CREATE", { userId, roleId: role.id, scopeType: "ORGANIZATION" }, audit3.currentHash
        );

        // Entry 5
        await createAuditLog(
          "permissions_initialized", "Permission", role.id, "CREATE", { roleId: role.id, permissionCount: allPermissions.length }, audit4.currentHash
        );

        return {
          success: true,
          departmentId: department.id,
          teamId: team.id,
          roleId: role.id,
        };
      });
    } catch (error: any) {
      console.error('[OrgInitService] Failed to initialize org RBAC:', error);
      return {
        success: false,
        error: error.message || 'Internal Server Error',
        code: 'ORG_INIT_FAILED'
      };
    }
  }
}

export default OrgInitService;
