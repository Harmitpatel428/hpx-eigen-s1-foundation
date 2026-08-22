import { PrismaClient, ScopeType, Prisma } from '@prisma/client';
import crypto from 'crypto';

/**
 * The administrative role every new organization must have exactly one of.
 * Roles are strictly tenant-scoped in this schema (@@unique([tenantId, name])),
 * so the default admin role is created per-tenant inside the signup
 * transaction rather than seeded as a global row.
 */
export const DEFAULT_ADMIN_ROLE_NAME = 'Organization Admin';

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

export type OrgRbacInitResult = {
  departmentId: string;
  teamId: string;
  roleId: string;
  lastAuditHash: string | null;
};

export class OrgInitService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Initializes the RBAC structure for a new organization inside an EXISTING
   * transaction. Throws on any failure so the caller's transaction rolls back —
   * never swallow errors here or the caller will commit partial state.
   *
   * @param tx An open Prisma interactive-transaction client
   * @param tenantId The UUID of the newly created Tenant
   * @param userId The UUID of the newly created User
   * @param opts.departmentName Optional custom department name (defaults to "Administration")
   * @param opts.teamName Optional custom team name (defaults to "Admin")
   * @param opts.previousAuditHash Hash-chain continuation point (last AuditLog currentHash)
   */
  async initializeOrgRBACWithinTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    opts: {
      departmentName?: string;
      teamName?: string;
      previousAuditHash?: string | null;
    } = {}
  ): Promise<OrgRbacInitResult> {
    const departmentName = opts.departmentName ?? 'Administration';
    const teamName = opts.teamName ?? 'Admin';

    // 1. Create Department (root admin dept)
    const department = await tx.department.create({
      data: { tenantId, name: departmentName }
    });

    // 2. Create Team (root admin team, link to dept)
    const team = await tx.team.create({
      data: {
        tenantId,
        departmentId: department.id,
        name: teamName,
      }
    });

    // 3. Create the default admin role (hardcoded — never client input)
    const role = await tx.role.create({
      data: {
        tenantId,
        name: DEFAULT_ADMIN_ROLE_NAME,
        isSystem: true,
      }
    });

    // 4. Grant the role every permission in the system
    const allPermissions = await tx.permission.findMany();
    if (allPermissions.length > 0) {
      await tx.rolePermission.createMany({
        data: allPermissions.map(p => ({
          roleId: role.id,
          permissionId: p.id
        }))
      });
    }

    // 5. Assign the role to the user with ORGANIZATION scope
    await tx.userRole.create({
      data: {
        userId,
        roleId: role.id,
        scopeType: ScopeType.ORGANIZATION,
      }
    });

    // 6. Attach the user to the admin department/team
    await tx.user.update({
      where: { id: userId },
      data: {
        departmentId: department.id,
        teamId: team.id,
      }
    });

    // 7. Immutable audit entries (SHA-256 hash chained)
    const generateHash = (eventData: unknown, previousHash: string | null): string => {
      return crypto.createHash('sha256').update(JSON.stringify(eventData) + (previousHash || '')).digest('hex');
    };

    const createAuditLog = async (
      eventType: string,
      entityType: string,
      entityId: string,
      operation: string,
      payload: Prisma.InputJsonValue,
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

    let previousHash: string | null = opts.previousAuditHash ?? null;

    const audit1 = await createAuditLog(
      "department_created", "Department", department.id, "CREATE", { name: departmentName }, previousHash
    );
    previousHash = audit1.currentHash;

    const audit2 = await createAuditLog(
      "team_created", "Team", team.id, "CREATE", { name: teamName, departmentId: department.id }, previousHash
    );

    const audit3 = await createAuditLog(
      "role_created", "Role", role.id, "CREATE", { name: DEFAULT_ADMIN_ROLE_NAME, level: "ORGANIZATION" }, audit2.currentHash
    );

    const audit4 = await createAuditLog(
      "role_assigned", "UserRole", `${userId}_${role.id}`, "CREATE", { userId, roleId: role.id, scopeType: "ORGANIZATION" }, audit3.currentHash
    );

    const audit5 = await createAuditLog(
      "permissions_initialized", "Permission", role.id, "CREATE", { roleId: role.id, permissionCount: allPermissions.length }, audit4.currentHash
    );

    return {
      departmentId: department.id,
      teamId: team.id,
      roleId: role.id,
      lastAuditHash: audit5.currentHash,
    };
  }

  /**
   * Standalone entry point — opens its own transaction around
   * initializeOrgRBACWithinTx. Kept for callers that already have a created
   * Tenant + User (e.g., repair scripts); signup uses WithinTx directly.
   */
  async initializeOrgRBAC(
    tenantId: string,
    userId: string,
    departmentName: string = 'Administration',
    teamName: string = 'Admin'
  ): Promise<InitializeOrgRBACResult> {
    try {
      const result = await this.prisma.$transaction((tx) =>
        this.initializeOrgRBACWithinTx(tx, tenantId, userId, { departmentName, teamName })
      );
      return {
        success: true,
        departmentId: result.departmentId,
        teamId: result.teamId,
        roleId: result.roleId,
      };
    } catch (error) {
      console.error('[OrgInitService] Failed to initialize org RBAC:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Internal Server Error',
        code: 'ORG_INIT_FAILED'
      };
    }
  }
}

export default OrgInitService;
