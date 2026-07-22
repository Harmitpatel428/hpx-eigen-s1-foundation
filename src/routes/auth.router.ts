import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { AuthService } from '../services/auth.service';
import { ValidationError } from '../types/exceptions';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { emailService } from '../services/email.service';
export function createAuthRouter(prisma: PrismaClient): Router {
  const router = Router();
  const authService = new AuthService(prisma);

  // ─── POST /api/auth/signup ────────────────────────────────────────
  /** Public — register a new tenant and user */
  router.post('/signup', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, companyName } = req.body;

      if (!email || !password || !companyName) {
        throw new ValidationError('Email, password, and companyName are required.');
      }
      if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        throw new ValidationError('Password must be at least 8 chars, with 1 uppercase and 1 number.');
      }

      // Check if user already exists across any tenant (based on prompt, email must be unique or handled per tenant)
      // Since email is unique per tenant, we should probably just check if email exists globally or assume they want one account per email.
      // We will create a tenant, user, and role.
      
      const existingUser = await prisma.user.findFirst({ where: { email } });
      if (existingUser) {
        return res.status(409).json({ error: 'USER_EXISTS', message: 'Email already registered' });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 12);

      // Create Tenant
      const tenant = await prisma.tenant.create({
        data: { name: companyName }
      });

      // Create User (status NEW)
      const user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          tenantId: tenant.id,
          emailVerified: null
        }
      });

      // Ensure 'ADMIN' role exists for this tenant
      let adminRole = await prisma.role.findFirst({
        where: { tenantId: tenant.id, name: 'ADMIN' }
      });
      if (!adminRole) {
        adminRole = await prisma.role.create({
          data: { tenantId: tenant.id, name: 'ADMIN', description: 'Administrator' }
        });
      }

      // Assign ADMIN role to the user
      await prisma.userRole.create({
        data: { userId: user.id, roleId: adminRole.id }
      });

      // Generate verification token (32-char hex)
      const token = crypto.randomBytes(32).toString('hex');
      
      // Delete old tokens for this email and create a new one
      await prisma.verificationToken.deleteMany({ where: { email } });
      await prisma.verificationToken.create({
        data: {
          email,
          token,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000) // 15 min
        }
      });

      // Send verification email
      await emailService.sendVerificationEmail(email, token);

      res.status(201).json({
        message: 'Signup successful. Check your email to verify account.',
        userId: user.id,
        tenantId: tenant.id
      });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/auth/verify ─────────────────────────────────────────
  /** Public — verify email via token */
  router.get('/verify', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = req.query as { token: string };

      if (!token) {
        throw new ValidationError('Verification token required.');
      }

      const verificationToken = await prisma.verificationToken.findUnique({ where: { token } });

      if (!verificationToken) {
        return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Token not found or already used' });
      }

      if (verificationToken.expiresAt < new Date()) {
        await prisma.verificationToken.deleteMany({ where: { email: verificationToken.email } });
        return res.status(400).json({ error: 'TOKEN_EXPIRED', message: 'Link has expired. Request new verification email.' });
      }

      const user = await prisma.user.findFirst({
        where: { email: verificationToken.email }
      });

      if (!user) {
        return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User account not found' });
      }

      // Update user
      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: new Date() }
      });

      // Clear tokens
      await prisma.verificationToken.deleteMany({
        where: { email: verificationToken.email }
      });

      res.status(200).json({
        message: 'Email verified successfully! You can now login.',
        email: user.email
      });
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/auth/login ─────────────────────────────────────────
  /** Public — authenticate with email + password, returns accessToken + sessionId */
  router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, email, password, deviceName } = req.body as {
        tenantId: string;
        email: string;
        password: string;
        deviceName?: string;
      };

      if (!tenantId || !email || !password) {
        throw new ValidationError('tenantId, email, and password are required.');
      }

      const result = await authService.login(tenantId, email, password, {
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
  /** Protected — revokes the current session */
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
  /** Protected — returns the authenticated user's profile */
  router.get('/me', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;

      const user = await prisma.user.findFirst({
        where: { id: userId, tenantId, deletedAt: null },
        select: {
          id: true,
          email: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          userRoles: {
            where: { deletedAt: null },
            select: {
              role: { select: { id: true, name: true } }
            }
          }
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
  /**
   * Protected — issues a new short-lived accessToken (15m) from a valid refresh token.
   * Body: { refreshToken: string }
   */
  router.post('/refresh', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId, tenantId } = (req as AuthenticatedRequest).user;
      const { refreshToken } = req.body as { refreshToken: string };

      if (!refreshToken) {
        throw new ValidationError('refreshToken is required.');
      }

      const result = await authService.refresh(sessionId, refreshToken, tenantId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
