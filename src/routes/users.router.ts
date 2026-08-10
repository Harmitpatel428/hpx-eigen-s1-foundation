import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { UserService } from '../services/user.service';
import { InvitationService } from '../services/invitation.service';
import { AdminLockoutService } from '../services/admin-lockout.service';
import { ValidationError, BusinessRuleViolationError, DuplicateResourceError } from '../types/exceptions';
import { checkInviteCreation } from '../services/auth/RateLimitService';

export function createUsersRouter(prisma: PrismaClient): Router {
  const router = Router();
  const userService = new UserService(prisma);
  const invitationService = new InvitationService(prisma);
  const adminLockoutService = new AdminLockoutService(prisma);

  router.use(authMiddleware);

  // ─── GET /api/users/me ────────────────────────────────────────────
  router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;

      const user = await prisma.user.findFirst({
        where: { id: userId, tenantId, deletedAt: { equals: null } },
        include: {
          userRoles: {
            include: {
              role: {
                include: { permissions: { include: { permission: true } } }
              }
            }
          }
        }
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          error: { code: 'USER_NOT_FOUND', message: 'User profile not found.' }
        });
      }

      const permissions = user.userRoles.reduce((acc: any, ur: any) => {
        ur.role.permissions.forEach((rp: any) => {
          acc[rp.permission.slug] = true;
        });
        return acc;
      }, {});

      const transformedUser = {
        id: user.id,
        email: user.email,
        name: (user as any).name || user.email,
        tenantId: user.tenantId,
        permissions,
        roles: user.userRoles.map((ur: any) => ur.role.name)
      };

      res.json({
        success: true,
        data: transformedUser
      });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/users ───────────────────────────────────────────────
  router.get('/', permissionMiddleware('user:view'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const users = await userService.listUsers(tenantId);
      res.json(users);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/users/invite ───────────────────────────────────────
  router.post('/invite', permissionMiddleware('user:manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const { email, roleId } = req.body as { email: string; roleId: string };

      if (!email || !roleId) throw new ValidationError('email and roleId are required.');

      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      await checkInviteCreation(userId, tenantId, ip);

      let result;
      try {
        result = await invitationService.createInvitation(tenantId, email, roleId, userId);
      } catch (err: any) {
        // Prisma P2002 unique constraint — concurrent invite creation race
        if (err?.code === 'P2002') throw new DuplicateResourceError('An invitation already exists for this email.');
        throw err;
      }

      res.status(201).json({
        invitationId: result.invitationId,
        emailStatus: result.emailStatus,
        ...(result.devInviteUrl ? { devInviteUrl: result.devInviteUrl } : {})
      });
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT /api/users/:id/suspend ───────────────────────────────────
  router.put('/:id/suspend', permissionMiddleware('user:manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId: actorUserId, tenantId } = (req as AuthenticatedRequest).user;
      const targetUserId = req.params['id'] as string;
      const { reason } = req.body as { reason?: string };

      if (!reason) {
        throw new ValidationError('reason is required for suspension.');
      }

      if (targetUserId === actorUserId) {
        throw new BusinessRuleViolationError();
      }

      const targetHasManage = await prisma.rolePermission.findFirst({
        where: {
          permission: { slug: 'role:manage' },
          role: { tenantId, deletedAt: { equals: null }, users: { some: { userId: targetUserId } } },
        },
      });

      let result;
      if (targetHasManage) {
        result = await adminLockoutService.withAdminGuard(
          tenantId,
          { skipUserId: targetUserId },
          async (tx) => userService.suspendUser(targetUserId, tenantId, reason, actorUserId, tx)
        );
      } else {
        result = await userService.suspendUser(targetUserId, tenantId, reason, actorUserId);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT /api/users/:id/terminate ────────────────────────────────
  router.put('/:id/terminate', permissionMiddleware('user:manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId: actorUserId, tenantId } = (req as AuthenticatedRequest).user;
      const targetUserId = req.params['id'] as string;
      const { reason } = req.body as { reason?: string };

      if (!reason) {
        throw new ValidationError('reason is required for termination.');
      }

      if (targetUserId === actorUserId) {
        throw new BusinessRuleViolationError();
      }

      const targetHasManage = await prisma.rolePermission.findFirst({
        where: {
          permission: { slug: 'role:manage' },
          role: { tenantId, deletedAt: { equals: null }, users: { some: { userId: targetUserId } } },
        },
      });

      let result;
      if (targetHasManage) {
        result = await adminLockoutService.withAdminGuard(
          tenantId,
          { skipUserId: targetUserId },
          async (tx) => userService.terminateUser(targetUserId, tenantId, reason, actorUserId, tx)
        );
      } else {
        result = await userService.terminateUser(targetUserId, tenantId, reason, actorUserId);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
