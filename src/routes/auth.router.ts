import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { AuthService } from '../services/auth.service';
import { PermissionService } from '../services/permission.service';
import { emailService } from '../services/email.service';
import { logger } from '../utils/logger';
import { validate } from '../middleware/validate.middleware';
import { authLimiter } from '../middleware/rateLimiter.middleware';
import { signupSchema, verifySchema, loginSchema, refreshSchema } from 'contracts';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export function createAuthRouter(prisma: PrismaClient): Router {
  const router = Router();
  const authService = new AuthService(prisma);
  const permissionService = new PermissionService(prisma);

  // ─── POST /api/auth/signup ────────────────────────────────────────
  router.post('/signup', authLimiter as any, validate(signupSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, companyName } = req.body;

      const existingUser = await prisma.user.findFirst({ where: { email } });
      if (existingUser) {
        return res.status(409).json({ code: 'USER_EXISTS', message: 'Email already registered' });
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      const token = crypto.randomBytes(32).toString('hex');

      // CRITICAL FIX: Wrap interdependent DB mutations in a transaction
      const result = await prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({ data: { name: companyName } });

        const user = await tx.user.create({
          data: {
            email,
            password: hashedPassword,
            tenantId: tenant.id,
            emailVerified: null
          }
        });

        const allPermissions = await tx.permission.findMany();

        let adminRole = await tx.role.findFirst({
          where: { tenantId: tenant.id, name: 'Organization Admin' }
        });

        if (!adminRole) {
          adminRole = await tx.role.create({
            data: { tenantId: tenant.id, name: 'Organization Admin', isSystem: true }
          });

          if (allPermissions.length > 0) {
            await tx.rolePermission.createMany({
              data: allPermissions.map(p => ({
                roleId: adminRole!.id,
                permissionId: p.id
              }))
            });
          }
        }

        await tx.userRole.create({
          data: { userId: user.id, roleId: adminRole!.id, scopeType: 'ORGANIZATION' }
        });

        await tx.verificationToken.deleteMany({ where: { email } });
        await tx.verificationToken.create({
          data: {
            email,
            token,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000)
          }
        });

        return { userId: user.id, tenantId: tenant.id };
      });

      // Invalidate tenant-wide cache for newly provisioned tenant
      await permissionService.invalidateTenantPermissionCache(result.tenantId);

      const verifyUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
      try {
        await emailService.sendVerificationEmail(email, token);
      } catch (emailError) {
        logger.error({ err: emailError, verifyUrl }, 'Signup Email Failed. Verification URL for manual testing');
      }

      res.status(201).json({
        message: 'Signup successful. Check your email to verify account.',
        userId: result.userId,
        tenantId: result.tenantId
      });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/auth/verify ─────────────────────────────────────────
  router.get('/verify', authLimiter as any, validate(verifySchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      // req.query.token is strictly typed and guaranteed to be a 64-char string by Zod
      const { token } = req.query as { token: string };

      const verificationToken = await prisma.verificationToken.findUnique({ where: { token } });

      if (!verificationToken) {
        return res.status(400).json({ code: 'INVALID_TOKEN', message: 'Token not found or already used' });
      }

      if (verificationToken.expiresAt < new Date()) {
        await prisma.verificationToken.deleteMany({ where: { email: verificationToken.email } });
        return res.status(400).json({ code: 'TOKEN_EXPIRED', message: 'Link has expired. Request new verification email.' });
      }

      const user = await prisma.user.findFirst({ where: { email: verificationToken.email } });
      if (!user) {
        return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'User account not found' });
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: new Date() }
      });

      await prisma.verificationToken.deleteMany({ where: { email: verificationToken.email } });

      res.status(200).json({ message: 'Email verified successfully! You can now login.', email: user.email });
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/auth/login ─────────────────────────────────────────
  router.post('/login', authLimiter as any, validate(loginSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, deviceName } = req.body;

      const result = await authService.login(email, password, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        deviceName
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/auth/logout ────────────────────────────────────────
  router.post('/logout', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId, sessionId } = (req as AuthenticatedRequest).user;
      await authService.logout(sessionId, tenantId, userId);
      res.json({ message: 'Logged out successfully.' });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/auth/me ─────────────────────────────────────────────
  router.get('/me', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;

      const user = await prisma.user.findFirst({
        where: { id: userId, tenantId, deletedAt: null },
        select: {
          id: true, email: true, status: true, createdAt: true, updatedAt: true,
          userRoles: { select: { role: { select: { id: true, name: true } } } }
        }
      });

      if (!user) {
        res.status(404).json({ code: 'RESOURCE_NOT_FOUND', message: 'User not found.' });
        return;
      }

      res.json(user);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/auth/refresh ───────────────────────────────────────
  // CRITICAL FIX: Removed authMiddleware. The refresh token is the credential.
  router.post('/refresh', authLimiter as any, validate(refreshSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body;

      // AuthService extracts the sessionId and performs rotation
      const result = await authService.refresh(refreshToken);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/auth/manifest ───────────────────────────────────────
  router.get('/manifest', authMiddleware, (req: Request, res: Response) => {
    const { permissions } = (req as AuthenticatedRequest).user;
    res.json(permissions);
  });

  return router;
}
