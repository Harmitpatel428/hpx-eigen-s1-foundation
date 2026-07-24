import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, ScopeType } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { PermissionService } from '../services/permission.service';
import { ValidationError, DuplicateResourceError, ResourceNotFoundError } from '../types/exceptions';

export function createRolesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const permissionService = new PermissionService(prisma);

  router.use(authMiddleware);

  // ─── GET /api/v1/roles ────────────────────────────────────────────
  /** List all non-deleted roles in the caller's tenant */
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const roles = await prisma.role.findMany({
        where: { tenantId, deletedAt: null },
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
  /** Create a new role in the caller's tenant */
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const { name } = req.body as { name: string };

      if (!name || name.trim().length === 0) {
        throw new ValidationError('name is required.');
      }

      const existing = await prisma.role.findFirst({
        where: { tenantId, name: name.trim(), deletedAt: null },
      });
      if (existing) throw new DuplicateResourceError();

      const role = await prisma.role.create({
        data: { tenantId, name: name.trim() },
        select: { id: true, name: true, isSystem: true, createdAt: true },
      });

      res.status(201).json(role);
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/v1/roles/:id/permissions ───────────────────────────
  /** List all permissions assigned to a role */
  router.get('/:id/permissions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const role = await prisma.role.findFirst({
        where: { id: req.params.id, tenantId, deletedAt: null },
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
  /** Add a permission to a role (idempotent) */
  router.post('/:id/permissions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const { permissionId } = req.body as { permissionId: string };

      if (!permissionId) throw new ValidationError('permissionId is required.');

      const role = await prisma.role.findFirst({
        where: { id: req.params.id, tenantId, deletedAt: null },
      });
      if (!role) throw new ResourceNotFoundError();

      const permission = await prisma.permission.findUnique({ where: { id: permissionId } });
      if (!permission) throw new ValidationError('permissionId references a non-existent permission.');

      // Upsert — idempotent
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: req.params.id, permissionId } },
        create: { roleId: req.params.id, permissionId },
        update: {},
      });

      // Invalidate permission cache for this tenant
      await permissionService.invalidatePermissionCache(tenantId);

      res.status(201).json({ message: 'Permission added.' });
    } catch (err) {
      next(err);
    }
  });

  // ─── DELETE /api/v1/roles/:id/permissions/:permissionId ──────────
  /** Remove a permission from a role (physical delete) */
  router.delete('/:id/permissions/:permissionId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const role = await prisma.role.findFirst({
        where: { id: req.params.id, tenantId, deletedAt: null },
      });
      if (!role) throw new ResourceNotFoundError();

      await prisma.rolePermission.deleteMany({
        where: { roleId: req.params.id, permissionId: req.params.permissionId },
      });

      // Invalidate permission cache for this tenant
      await permissionService.invalidatePermissionCache(tenantId);

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/v1/roles/:id/users ─────────────────────────────────
  /** List users assigned to a role with their scope */
  router.get('/:id/users', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const role = await prisma.role.findFirst({
        where: { id: req.params.id, tenantId, deletedAt: null },
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
  /** Assign a role to a user with a specific ABAC scope */
  router.post('/:id/users', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
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
        where: { id: req.params.id, tenantId, deletedAt: null },
      });
      if (!role) throw new ResourceNotFoundError();

      const user = await prisma.user.findFirst({
        where: { id: userId, tenantId, deletedAt: null },
      });
      if (!user) throw new ValidationError('userId references a non-existent user.');

      // Upsert — allows updating scopeType on existing assignment
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId, roleId: req.params.id } },
        create: {
          userId,
          roleId: req.params.id,
          scopeType: scopeType ?? ScopeType.OWN,
        },
        update: { scopeType: scopeType ?? ScopeType.OWN },
      });

      // Invalidate permission cache for this tenant
      await permissionService.invalidatePermissionCache(tenantId);

      res.status(201).json({ message: 'Role assigned.' });
    } catch (err) {
      next(err);
    }
  });

  // ─── DELETE /api/v1/roles/:id/users/:userId ───────────────────────
  /** Unassign a role from a user (physical delete) */
  router.delete('/:id/users/:userId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const role = await prisma.role.findFirst({
        where: { id: req.params.id, tenantId, deletedAt: null },
      });
      if (!role) throw new ResourceNotFoundError();

      await prisma.userRole.deleteMany({
        where: { roleId: req.params.id, userId: req.params.userId },
      });

      // Invalidate permission cache for this tenant
      await permissionService.invalidatePermissionCache(tenantId);

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/v1/roles/permissions/all ────────────────────────────
  /** List all global permissions (for Admin Console matrix builder) */
  router.get('/permissions/all', async (_req: Request, res: Response, next: NextFunction) => {
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
