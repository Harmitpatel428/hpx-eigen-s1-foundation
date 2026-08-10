import { PrismaClient, Prisma } from '@prisma/client';
import { BusinessRuleViolationError } from '../types/exceptions';

export class AdminLockoutService {
  constructor(private readonly prisma: PrismaClient) {}

  // ponytail: Serializable isolation instead of SELECT FOR UPDATE — avoids raw SQL
  // column-name issues (see invitation.service.ts snake_case bug). SSI detects
  // read/write conflicts; concurrent admin-removing ops cause one to abort (P2034).
  // Upgrade to advisory locks if serialization failures become noisy at scale.
  async withAdminGuard<T>(
    tenantId: string,
    checkOpts: {
      skipRoleId?: string;
      skipUserRole?: { userId: string; roleId: string };
      skipUserId?: string;
    },
    mutationFn: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const roleManagePerm = await tx.permission.findFirst({ where: { slug: 'role:manage' } });
      if (!roleManagePerm) return mutationFn(tx);

      const rolesWithManage = await tx.rolePermission.findMany({
        where: { permissionId: roleManagePerm.id, role: { tenantId, deletedAt: { equals: null } } },
        select: { roleId: true },
      });

      let roleIds = rolesWithManage.map(r => r.roleId);
      if (checkOpts.skipRoleId) roleIds = roleIds.filter(id => id !== checkOpts.skipRoleId);

      if (roleIds.length === 0) throw new BusinessRuleViolationError();

      const assignments = await tx.userRole.findMany({
        where: {
          roleId: { in: roleIds },
          user: { tenantId, deletedAt: { equals: null }, status: 'ACTIVE' },
        },
        select: { userId: true, roleId: true },
      });

      let remaining = assignments;
      if (checkOpts.skipUserRole) {
        remaining = remaining.filter(a =>
          !(a.userId === checkOpts.skipUserRole!.userId && a.roleId === checkOpts.skipUserRole!.roleId)
        );
      }
      if (checkOpts.skipUserId) {
        remaining = remaining.filter(a => a.userId !== checkOpts.skipUserId);
      }

      if (new Set(remaining.map(a => a.userId)).size === 0) {
        throw new BusinessRuleViolationError();
      }

      return mutationFn(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
