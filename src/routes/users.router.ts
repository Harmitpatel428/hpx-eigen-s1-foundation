import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { UserService } from '../services/user.service';
import { InvitationService } from '../services/invitation.service';
import { ValidationError } from '../types/exceptions';

export function createUsersRouter(prisma: PrismaClient): Router {
  const router = Router();
  const userService = new UserService(prisma);
  const invitationService = new InvitationService(prisma);

  // All user routes require authentication
  router.use(authMiddleware);

  // ─── GET /api/users ───────────────────────────────────────────────
  /** List all non-deleted users in the caller's tenant */
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const users = await userService.listUsers(tenantId);
      res.json(users);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/users/invite ───────────────────────────────────────
  /**
   * Invite a user to the tenant via email.
   * Body: { email: string, roleId: string }
   * Returns: { invitationId, token, expiresAt }
   */
  router.post('/invite', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const { email, roleId } = req.body as { email: string; roleId: string };

      if (!email || !roleId) {
        throw new ValidationError('email and roleId are required.');
      }

      const invitation = await invitationService.createInvitation(tenantId, email, roleId, userId);

      res.status(201).json({
        invitationId: invitation.id,
        token: invitation.token,
        expiresAt: invitation.expiresAt
      });
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT /api/users/:id/suspend ───────────────────────────────────
  /**
   * Suspend a user — sets status to SUSPENDED, invalidates all sessions.
   * Body: { reason: string }
   * Returns: { success: true, sessionsRevoked: number }
   */
  router.put('/:id/suspend', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId: actorUserId, tenantId } = (req as AuthenticatedRequest).user;
      const targetUserId = req.params['id'] as string;
      const { reason } = req.body as { reason?: string };

      if (!reason) {
        throw new ValidationError('reason is required for suspension.');
      }

      const result = await userService.suspendUser(targetUserId, tenantId, reason, actorUserId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT /api/users/:id/terminate ────────────────────────────────
  /**
   * Terminate a user permanently — sets status to TERMINATED, invalidates all sessions.
   * Body: { reason: string }
   * Returns: { success: true, sessionsRevoked: number }
   */
  router.put('/:id/terminate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId: actorUserId, tenantId } = (req as AuthenticatedRequest).user;
      const targetUserId = req.params['id'] as string;
      const { reason } = req.body as { reason?: string };

      if (!reason) {
        throw new ValidationError('reason is required for termination.');
      }

      const result = await userService.terminateUser(targetUserId, tenantId, reason, actorUserId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
