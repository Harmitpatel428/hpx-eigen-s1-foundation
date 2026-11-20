import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { UserService } from '../services/user.service';
import { InvitationService } from '../services/invitation.service';
import { AdminLockoutService } from '../services/admin-lockout.service';
import { ValidationError, BusinessRuleViolationError, DuplicateResourceError } from '../types/exceptions';
import { AuditService } from '../services/audit.service';
import { NotificationService } from '../services/notification.service';
import { emailService } from '../services/email.service';
import { checkInviteCreation } from '../services/auth/RateLimitService';

export function createUsersRouter(prisma: PrismaClient): Router {
  const router = Router();
  const userService = new UserService(prisma);
  const invitationService = new InvitationService(prisma);
  const adminLockoutService = new AdminLockoutService(prisma);
  const auditService = new AuditService(prisma);
  const notificationService = new NotificationService(prisma);

  router.use(authMiddleware);

  // ─── GET /api/users/me ────────────────────────────────────────────
  router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;

      const user = await prisma.user.findFirst({
        where: { id: userId, tenantId, deletedAt: { equals: null } },
        include: {
          department: { select: { id: true, name: true } },
          team: { select: { id: true, name: true } },
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

      const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || null;

      const { impersonatedByUserId } = (req as AuthenticatedRequest).user;

      const transformedUser = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        name: fullName || user.email,
        phone: user.phone,
        avatarUrl: user.avatarUrl,
        tenantId: user.tenantId,
        department: user.department,
        team: user.team,
        permissions,
        roles: user.userRoles.map((ur: any) => ur.role.name),
        isImpersonated: !!impersonatedByUserId,
        impersonatedByUserId: impersonatedByUserId ?? null,
      };

      res.json({
        success: true,
        data: transformedUser
      });
    } catch (err) {
      next(err);
    }
  });

  // ─── PATCH /api/users/me ───────────────────────────────────────────
  router.patch('/me', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const { firstName, lastName, phone, avatarUrl } = req.body;

      // Mass-assignment guard: only allow explicit profile fields
      const data: Record<string, string | null> = {};
      if (firstName !== undefined) data.firstName = typeof firstName === 'string' ? firstName.trim().slice(0, 100) : null;
      if (lastName !== undefined) data.lastName = typeof lastName === 'string' ? lastName.trim().slice(0, 100) : null;
      if (phone !== undefined) data.phone = typeof phone === 'string' ? phone.trim().slice(0, 30) : null;
      if (avatarUrl !== undefined) data.avatarUrl = typeof avatarUrl === 'string' ? avatarUrl.trim().slice(0, 500) : null;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ success: false, code: 'NO_FIELDS', message: 'No updatable fields provided.' });
      }

      const beforeState = await prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true, phone: true, avatarUrl: true },
      });

      await prisma.user.update({
        where: { id: userId },
        data,
      });

      try {
        await auditService.log({
          tenantId,
          eventType: 'PROFILE_UPDATED',
          entityType: 'User',
          entityId: userId,
          actorUserId: userId,
          actorIp: req.ip,
          actorUserAgent: req.headers['user-agent'],
          operation: 'UPDATE_PROFILE',
          payload: data,
          beforeState: beforeState as Record<string, unknown>,
        });
      } catch (e) {
        console.error('[AUDIT_DELIVERY_FAILURE]', e);
      }

      res.json({ success: true, message: 'Profile updated.' });
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
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new ValidationError('Invalid email address.');

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

  // ─── PUT /api/users/:id/password ──────────────────────────────────
  // Admin-only member password reset (Settings → Members → Change Password).
  // Gated on `user:password:reset`, a STRICTLY-admin marker — NOT `user:manage`, which tenants
  // routinely delegate to HR/Support/Dept managers (letting them reset an admin's password is a
  // privilege-escalation vector). The seed grants this marker to Organization Admin only.
  // Server-enforced — the UI gate is convenience. Self is excluded: an admin changes their OWN
  // password via POST /api/auth/change-password, keeping self-service separate and avoiding a
  // self-session-revoke lockout here.
  router.put('/:id/password', permissionMiddleware('user:password:reset'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId: actorUserId, tenantId } = (req as AuthenticatedRequest).user;
      const targetUserId = req.params['id'] as string;
      const { newPassword } = req.body as { newPassword?: unknown };

      if (typeof newPassword !== 'string' || newPassword.length === 0) {
        throw new ValidationError('newPassword is required.');
      }
      if (targetUserId === actorUserId) {
        throw new BusinessRuleViolationError('Use account settings to change your own password.');
      }

      const { sessionsRevoked, email } = await userService.adminResetPassword(
        targetUserId, tenantId, actorUserId, newPassword,
      );

      // Security comms are best-effort and fire AFTER the password commit (mirrors
      // /api/auth/reset-password); a mail/notification hiccup must not fail the reset.
      await emailService.sendPasswordChangedEmail(email).catch(e =>
        console.error('[ADMIN_PASSWORD_RESET] Security email failed:', e),
      );
      await notificationService.create({
        tenantId,
        recipientUserId: targetUserId,
        type: 'PASSWORD_RESET_COMPLETED',
        title: 'Password changed by an administrator',
        message: 'An administrator set a new password for your account. All active sessions were signed out.',
      }).catch(e => console.error('[ADMIN_PASSWORD_RESET] Notification failed:', e));

      res.json({ success: true, message: 'Password updated. The member must sign in again.', sessionsRevoked });
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
