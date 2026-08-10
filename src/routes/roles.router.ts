import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, ScopeType } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { PermissionService } from '../services/permission.service';
import { AuditService } from '../services/audit.service';
import { AdminLockoutService } from '../services/admin-lockout.service';
import { ValidationError, DuplicateResourceError, ResourceNotFoundError } from '../types/exceptions';

export function createRolesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const permissionService = new PermissionService(prisma);
  const auditService = new AuditService(prisma);
  const adminLockoutService = new AdminLockoutService(prisma);

  router.use(authMiddleware);

  // ─── GET /api/v1/roles ────────────────────────────────────────────
  router.get('/', permissionMiddleware('role:view'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const roles = await prisma.role.findMany({
        where: { tenantId, deletedAt: { equals: null } },
        select: {
          id: true,
          name: true,
          isSystem: true,
          createdAt: true,
          _count: { select: { users: true } },
        },
        orderBy: { name: 'asc' },
      });

      res.json(roles);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/v1/roles ───────────────────────────────────────────
  router.post('/', permissionMiddleware('role:manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, userId: actorUserId } = (req as AuthenticatedRequest).user;
      const { name } = req.body as { name: string };

      if (!name || name.trim().length === 0) {
        throw new ValidationError('name is required.');
      }

      const existing = await prisma.role.findFirst({
        where: { tenantId, name: name.trim(), deletedAt: { equals: null } },
      });
      if (existing) throw new DuplicateResourceError();

      const role = await prisma.role.create({
        data: { tenantId, name: name.trim() },
        select: { id: true, name: true, isSystem: true, createdAt: true },
      });

      try {
        await auditService.log({
          tenantId,
          eventType: 'RoleCreated',
          entityType: 'Role',
          entityId: role.id,
          actorUserId,
          actorIp: req.ip,
          actorUserAgent: req.headers['user-agent'],
          operation: 'CREATE',
          payload: { name: role.name },
        });
      } catch (auditErr) {
        console.error('[AUDIT_DELIVERY_FAILURE]', { eventType: 'RoleCreated', entityId: role.id, tenantId }, auditErr);
      }

      res.status(201).json(role);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/v1/roles/:id/clone ─────────────────────────────────
  router.post('/:id/clone', permissionMiddleware('role:manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, userId: actorUserId } = (req as AuthenticatedRequest).user;

      const result = await prisma.$transaction(async (tx) => {
        const sourceRole = await tx.role.findFirst({
          where: { id: req.params.id, tenantId, deletedAt: { equals: null } },
        });
        if (!sourceRole) throw new ResourceNotFoundError();

        const cloneName = `${sourceRole.name} (Copy)`;
        const existing = await tx.role.findFirst({
          where: { tenantId, name: cloneName, deletedAt: { equals: null } },
        });
        if (existing) throw new DuplicateResourceError();

        const newRole = await tx.role.create({
          data: { tenantId, name: cloneName },
          select: { id: true, name: true, isSystem: true, createdAt: true },
        });

        const sourcePerms = await tx.rolePermission.findMany({
          where: { roleId: req.params.id },
          select: { permissionId: true },
        });

        if (sourcePerms.length > 0) {
          await tx.rolePermission.createMany({
            data: sourcePerms.map(sp => ({ roleId: newRole.id, permissionId: sp.permissionId })),
          });
        }

        return newRole;
      });

      try {
        await auditService.log({
          tenantId,
          eventType: 'RoleCloned',
          entityType: 'Role',
          entityId: result.id,
          actorUserId,
          actorIp: req.ip,
          actorUserAgent: req.headers['user-agent'],
          operation: 'CLONE',
          payload: { sourceRoleId: req.params.id, newRoleName: result.name },
        });
      } catch (auditErr) {
        console.error('[AUDIT_DELIVERY_FAILURE]', { eventType: 'RoleCloned', entityId: result.id, tenantId }, auditErr);
      }

      await permissionService.invalidatePermissionCache(tenantId);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/v1/roles/:id/permissions ───────────────────────────
  router.get('/:id/permissions', permissionMiddleware('role:view'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const role = await prisma.role.findFirst({
        where: { id: req.params.id, tenantId, deletedAt: { equals: null } },
      });
      if (!role) throw new ResourceNotFoundError();

      const rolePerms = await prisma.rolePermission.findMany({
        where: { roleId: req.params.id },
        include: {
          permission: { select: { id: true, slug: true, module: true, description: true } },
        },
      });

      res.json(rolePerms.map((rp) => rp.permission));
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/v1/roles/:id/permissions ──────────────────────────
  router.post('/:id/permissions', permissionMiddleware('role:manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, userId: actorUserId } = (req as AuthenticatedRequest).user;
      const { permissionId } = req.body as { permissionId: string };

      if (!permissionId) throw new ValidationError('permissionId is required.');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(permissionId)) {
        throw new ValidationError('permissionId must be a valid UUID.');
      }

      const role = await prisma.role.findFirst({
        where: { id: req.params.id, tenantId, deletedAt: { equals: null } },
      });
      if (!role) throw new ResourceNotFoundError();

      if (role.isSystem) {
        res.status(403).json({ error: 'SYSTEM_ROLE_PROTECTED', message: 'Cannot modify permissions on a system role.' });
        return;
      }

      const permission = await prisma.permission.findUnique({ where: { id: permissionId } });
      if (!permission) throw new ValidationError('permissionId references a non-existent permission.');

      const beforeState = await prisma.role.findUnique({ where: { id: req.params.id }, include: { permissions: true } });

      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: req.params.id, permissionId } },
        create: { roleId: req.params.id, permissionId },
        update: {},
      });

      const afterState = await prisma.role.findUnique({ where: { id: req.params.id }, include: { permissions: true } });

      // ponytail: audit is best-effort after commit. Failure logged, not thrown.
      // Migrate to transactional outbox when compliance requires guaranteed audit.
      try {
        await auditService.log({
          tenantId,
          eventType: 'RoleUpdated',
          entityType: 'Role',
          entityId: req.params.id,
          actorUserId,
          actorIp: req.ip,
          actorUserAgent: req.headers['user-agent'],
          operation: 'GRANT_PERMISSION',
          payload: { permissionId },
          beforeState: beforeState as unknown as Record<string, unknown>,
          afterState: afterState as unknown as Record<string, unknown>
        });
      } catch (auditErr) {
        console.error('[AUDIT_DELIVERY_FAILURE]', { eventType: 'RoleUpdated', entityId: req.params.id, tenantId }, auditErr);
      }

      await permissionService.invalidatePermissionCache(tenantId);

      res.status(201).json({ message: 'Permission added.' });
    } catch (err) {
      next(err);
    }
  });

  // ─── DELETE /api/v1/roles/:id/permissions/:permissionId ──────────
  router.delete('/:id/permissions/:permissionId', permissionMiddleware('role:manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, userId: actorUserId } = (req as AuthenticatedRequest).user;

      const role = await prisma.role.findFirst({
        where: { id: req.params.id, tenantId, deletedAt: { equals: null } },
      });
      if (!role) throw new ResourceNotFoundError();

      if (role.isSystem) {
        res.status(403).json({ error: 'SYSTEM_ROLE_PROTECTED', message: 'Cannot modify permissions on a system role.' });
        return;
      }

      const targetPerm = await prisma.permission.findUnique({ where: { id: req.params.permissionId } });
      if (targetPerm?.slug === 'role:manage') {
        await adminLockoutService.withAdminGuard(
          tenantId,
          { skipRoleId: req.params.id },
          async (tx) => {
            await tx.rolePermission.deleteMany({
              where: { roleId: req.params.id, permissionId: req.params.permissionId },
            });
          }
        );
      } else {
        await prisma.rolePermission.deleteMany({
          where: { roleId: req.params.id, permissionId: req.params.permissionId },
        });
      }

      try {
        const afterState = await prisma.role.findUnique({ where: { id: req.params.id }, include: { permissions: true } });
        await auditService.log({
          tenantId,
          eventType: 'RoleUpdated',
          entityType: 'Role',
          entityId: req.params.id,
          actorUserId,
          actorIp: req.ip,
          actorUserAgent: req.headers['user-agent'],
          operation: 'REVOKE_PERMISSION',
          payload: { permissionId: req.params.permissionId },
          afterState: afterState as unknown as Record<string, unknown>
        });
      } catch (auditErr) {
        console.error('[AUDIT_DELIVERY_FAILURE]', { eventType: 'RoleUpdated', entityId: req.params.id, tenantId }, auditErr);
      }

      await permissionService.invalidatePermissionCache(tenantId);

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/v1/roles/:id/users ─────────────────────────────────
  router.get('/:id/users', permissionMiddleware('role:view'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const role = await prisma.role.findFirst({
        where: { id: req.params.id, tenantId, deletedAt: { equals: null } },
      });
      if (!role) throw new ResourceNotFoundError();

      const userRoles = await prisma.userRole.findMany({
        where: { roleId: req.params.id },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              status: true,
              teamId: true,
              departmentId: true,
            },
          },
        },
      });

      res.json(
        userRoles.map((ur) => ({
          ...ur.user,
          scopeType: ur.scopeType,
        }))
      );
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/v1/roles/:id/users ────────────────────────────────
  router.post('/:id/users', permissionMiddleware('role:manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, userId: actorUserId } = (req as AuthenticatedRequest).user;
      const { userId, scopeType } = req.body as {
        userId: string;
        scopeType?: ScopeType;
      };

      if (!userId) throw new ValidationError('userId is required.');

      const validScopes = Object.values(ScopeType);
      if (scopeType && !validScopes.includes(scopeType)) {
        throw new ValidationError(`scopeType must be one of: ${validScopes.join(', ')}`);
      }

      const role = await prisma.role.findFirst({
        where: { id: req.params.id, tenantId, deletedAt: { equals: null } },
      });
      if (!role) throw new ResourceNotFoundError();

      const user = await prisma.user.findFirst({
        where: { id: userId, tenantId, deletedAt: { equals: null } },
      });
      if (!user) throw new ValidationError('userId references a non-existent user.');

      await prisma.userRole.upsert({
        where: { userId_roleId: { userId, roleId: req.params.id } },
        create: {
          userId,
          roleId: req.params.id,
          scopeType: scopeType ?? ScopeType.OWN,
        },
        update: { scopeType: scopeType ?? ScopeType.OWN },
      });

      try {
        await auditService.log({
          tenantId,
          eventType: 'UserRoleAssigned',
          entityType: 'UserRole',
          entityId: `${userId}:${req.params.id}`,
          actorUserId,
          actorIp: req.ip,
          actorUserAgent: req.headers['user-agent'],
          operation: 'ASSIGN_ROLE',
          payload: { userId, roleId: req.params.id, scopeType: scopeType ?? ScopeType.OWN },
        });
      } catch (auditErr) {
        console.error('[AUDIT_DELIVERY_FAILURE]', { eventType: 'UserRoleAssigned', entityId: `${userId}:${req.params.id}`, tenantId }, auditErr);
      }

      await permissionService.invalidatePermissionCache(tenantId);

      res.status(201).json({ message: 'Role assigned.' });
    } catch (err) {
      next(err);
    }
  });

  // ─── DELETE /api/v1/roles/:id/users/:userId ───────────────────────
  router.delete('/:id/users/:userId', permissionMiddleware('role:manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, userId: actorUserId } = (req as AuthenticatedRequest).user;

      const role = await prisma.role.findFirst({
        where: { id: req.params.id, tenantId, deletedAt: { equals: null } },
      });
      if (!role) throw new ResourceNotFoundError();

      const roleHasManage = await prisma.rolePermission.findFirst({
        where: { roleId: req.params.id, permission: { slug: 'role:manage' } },
      });

      if (roleHasManage) {
        await adminLockoutService.withAdminGuard(
          tenantId,
          { skipUserRole: { userId: req.params.userId, roleId: req.params.id } },
          async (tx) => {
            await tx.userRole.deleteMany({
              where: { roleId: req.params.id, userId: req.params.userId },
            });
          }
        );
      } else {
        await prisma.userRole.deleteMany({
          where: { roleId: req.params.id, userId: req.params.userId },
        });
      }

      try {
        await auditService.log({
          tenantId,
          eventType: 'UserRoleUnassigned',
          entityType: 'UserRole',
          entityId: `${req.params.userId}:${req.params.id}`,
          actorUserId,
          actorIp: req.ip,
          actorUserAgent: req.headers['user-agent'],
          operation: 'UNASSIGN_ROLE',
          payload: { userId: req.params.userId, roleId: req.params.id },
        });
      } catch (auditErr) {
        console.error('[AUDIT_DELIVERY_FAILURE]', { eventType: 'UserRoleUnassigned', entityId: `${req.params.userId}:${req.params.id}`, tenantId }, auditErr);
      }

      await permissionService.invalidatePermissionCache(tenantId);

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/v1/roles/permissions/all ────────────────────────────
  router.get('/permissions/all', permissionMiddleware('role:view'), async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const permissions = await prisma.permission.findMany({
        select: { id: true, slug: true, module: true, description: true },
        orderBy: [{ module: 'asc' }, { slug: 'asc' }],
      });
      res.json(permissions);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
