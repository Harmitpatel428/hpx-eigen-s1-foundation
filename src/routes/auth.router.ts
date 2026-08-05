import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { AuthService } from '../services/auth.service';
import { ValidationError } from '../types/exceptions';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { emailService } from '../services/email.service';
import { PermissionService } from '../services/permission.service';
import { TokenService } from '../services/auth/TokenService';
import { RateLimitService } from '../services/auth/RateLimitService';
import OrgInitService from '../services/rbac/OrgInitService';

export function createAuthRouter(prisma: PrismaClient): Router {
  const router = Router();
  const authService = new AuthService(prisma);
  const permissionService = new PermissionService(prisma);

  
  const tokenService = new TokenService(prisma);
  const rateLimitService = new RateLimitService();

  // ─── POST /api/auth/signup ────────────────────────────────────────
  router.post('/signup', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, companyName } = req.body;
      if (!email || !password || !companyName) throw new ValidationError('Email, password, and companyName are required.');
      if (password.length < 8) throw new ValidationError('Password must be at least 8 chars.');

      const existingUser = await prisma.user.findFirst({ where: { email } });
      if (existingUser) return res.status(409).json({ error: 'USER_EXISTS', message: 'Email already registered' });

      const hashedPassword = await bcrypt.hash(password, 12);
      let tenantId = "", userId = "";

      // 1. Create tenant and user
      await prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({ data: { name: companyName } });
        tenantId = tenant.id;

        const user = await tx.user.create({
          data: {
            email,
            password: hashedPassword,
            tenantId: tenant.id,
            emailVerified: null // CRITICAL: Start unverified
          }
        });
        userId = user.id;

        // 2. Generate verification token
        const token = tokenService.generateToken();
        const tokenHash = tokenService.hashToken(token);
        
        await tx.verificationToken.create({
          data: {
            userId: user.id,
            token,
            tokenHash,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
          }
        });

        // 3. Send email (fire and forget for now, or await)
        await emailService.sendVerificationEmail(email, token).catch(e => console.error('Email send failed', e));
        
        // 4. Audit
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            eventType: 'USER_REGISTERED',
            entityType: 'User',
            entityId: user.id,
            actorUserId: user.id,
            operation: 'CREATE',
            payload: { email, emailVerified: false },
            currentHash: crypto.randomBytes(32).toString('hex') // Mock hash for now
          }
        });
      });

      res.status(201).json({ success: true, message: 'Account created. Please verify your email.', email });
    } catch (err) { next(err); }
  });

  // ─── POST /api/auth/login ─────────────────────────────────────────
  router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ success: false, error: { message: 'Missing credentials' } });

      const attempts = await rateLimitService.checkLoginAttempts(email);
      if (attempts > 5) return res.status(429).json({ success: false, error: { message: 'Too many attempts' } });

      const user = await prisma.user.findFirst({
        where: { email: email.toLowerCase().trim(), deletedAt: null },
        include: { tenant: { select: { id: true, name: true } } }
      });

      if (!user) return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS' } });

      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS' } });

      // CRITICAL: Check if email verified
      if (user.emailVerified == null) {
        return res.status(403).json({
          success: false,
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Email address not verified. Check your inbox or request resend.',
          email: user.email,
          resendAvailable: true
        });
      }

      // Fetch all needed data BEFORE response (initialMetrics)
      const [permissions, metrics] = await Promise.all([
        permissionService.getPermissionManifest(user.id, user.tenantId).catch(() => ({})),
        { leads: 10, deals: 5, revenue: 50000 } // Mock initial metrics for instant hydration
      ]);

      const session = await prisma.session.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          status: 'ACTIVE',
          refreshTokenHash: await bcrypt.hash(crypto.randomBytes(64).toString('hex'), 12),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        }
      });

      const jwtToken = jwt.sign({ sub: user.id, tenantId: user.tenantId, sessionId: session.id }, process.env.JWT_SECRET!, { expiresIn: '7d' });

      res.json({
        success: true,
        jwt: jwtToken,
        user: { id: user.id, email: user.email, tenantId: user.tenantId },
        organization: { id: user.tenant.id, name: user.tenant.name },
        permissions,
        initialMetrics: { activeLeads: metrics.leads, deals: metrics.deals, revenue: metrics.revenue }
      });
    } catch (err) { next(err); }
  });

  // ─── POST /api/auth/verify-email ──────────────────────────────────
  router.post('/verify-email', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = req.body;
      if (!token) throw new ValidationError('Verification token required.');

      const tokenHash = tokenService.hashToken(token);
      const verificationToken = await tokenService.validateVerificationToken(tokenHash);
      
      const user = await prisma.user.findUnique({ where: { id: verificationToken.userId } });
      if (!user) throw new ValidationError('User not found');

      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: verificationToken.userId },
          data: { emailVerified: new Date(), verifiedAt: new Date() }
        });
        await tx.verificationToken.update({
          where: { id: verificationToken.id },
          data: { status: 'USED', usedAt: new Date(), deletedAt: new Date() }
        });
        await tx.verificationToken.updateMany({
          where: { userId: verificationToken.userId, id: { not: verificationToken.id }, deletedAt: null },
          data: { status: 'REVOKED', revokedAt: new Date(), deletedAt: new Date() }
        });
      });

      res.json({ success: true, message: 'Email verified. You can now login.' });
    } catch (err) { next(err); }
  });

  // ─── POST /api/auth/resend-verification ───────────────────────────
  router.post('/resend-verification', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body;
      const user = await prisma.user.findFirst({ where: { email } });
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.emailVerified != null) return res.status(409).json({ error: 'Email already verified' });

      const attempts = await rateLimitService.checkResendLimit(email);
      if (attempts > 3) return res.status(429).json({ error: 'Too many resend attempts. Try again in 1 hour.' });

      await tokenService.revokeOldTokens(user.id);

      const token = tokenService.generateToken();
      await prisma.verificationToken.create({
        data: {
          userId: user.id,
          token,
          tokenHash: tokenService.hashToken(token),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        }
      });

      await emailService.sendVerificationEmail(email, token).catch(e => console.error(e));
      res.json({ success: true, message: 'Verification email sent.' });
    } catch (err) { next(err); }
  });

  // ─── POST /api/auth/forgot-password ───────────────────────────────
  router.post('/forgot-password', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body;
      const user = await prisma.user.findFirst({ where: { email } });
      if (!user) return res.json({ message: 'If email exists, reset link sent' });

      await prisma.passwordResetToken.updateMany({
        where: { userId: user.id, status: 'PENDING' },
        data: { status: 'REVOKED', revokedAt: new Date() }
      });

      const resetToken = tokenService.generateToken();
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: tokenService.hashToken(resetToken),
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          status: 'PENDING'
        }
      });

      // await emailService.sendPasswordResetEmail(user.email, resetToken); // Mock
      res.json({ message: 'If email exists, reset link sent' });
    } catch (err) { next(err); }
  });

  // ─── POST /api/auth/reset-password ────────────────────────────────
  router.post('/reset-password', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token, newPassword } = req.body;
      const tokenHash = tokenService.hashToken(token);
      
      const resetToken = await prisma.passwordResetToken.findFirst({
        where: { tokenHash, status: 'PENDING', expiresAt: { gt: new Date() }, deletedAt: null },
        include: { user: true }
      });
      if (!resetToken) return res.status(400).json({ error: 'INVALID_TOKEN' });
      if (newPassword.length < 8) return res.status(400).json({ error: 'Min 8 chars' });

      const hashedPassword = await bcrypt.hash(newPassword, 12);
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: resetToken.userId }, data: { password: hashedPassword } });
        await tx.passwordResetToken.update({ where: { id: resetToken.id }, data: { status: 'USED', usedAt: new Date() } });
        await tx.session.updateMany({
          where: { userId: resetToken.userId, status: 'ACTIVE' },
          data: { status: 'REVOKED', revokedAt: new Date() }
        });
      });
      res.json({ message: 'Password reset successfully. Please login.' });
    } catch (err) { next(err); }
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
        where: { id: userId, tenantId, deletedAt: { equals: null } },
        select: {
          id: true,
          email: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          userRoles: {
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

  // ─── GET /api/auth/me/departments ─────────────────────────────────
  /** Protected — returns the authenticated user's departments */
  router.get('/me/departments', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;

      if (!userId || !tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Valid authentication required.' }
        });
      }

      // Fetch user's department (V1 schema — single departmentId)
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { department: true }
      });

      let departments: Array<{ id: string; type: string; name: string }> = [];

      if (user?.department) {
        // Map name to type for frontend compatibility
        const nameToType = (name: string): string => {
          const normalized = name.toLowerCase().trim();
          if (normalized.includes('sales')) return 'SALES';
          if (normalized.includes('process')) return 'PROCESS';
          if (normalized.includes('documentation') || normalized.includes('doc')) return 'DOCUMENTATION';
          return 'SALES'; // Default fallback
        };

        departments.push({
          id: user.department.id,
          type: nameToType(user.department.name),
          name: user.department.name,
        });
      }

      // Safety net: If user has no department, auto-assign to first available
      if (departments.length === 0) {
        const firstDept = await prisma.department.findFirst({
          where: { tenantId },
          orderBy: { createdAt: 'asc' }
        });

        if (firstDept) {
          // Update user with this department
          await prisma.user.update({
            where: { id: userId },
            data: { departmentId: firstDept.id }
          });

          const nameToType = (name: string): string => {
            const normalized = name.toLowerCase().trim();
            if (normalized.includes('sales')) return 'SALES';
            if (normalized.includes('process')) return 'PROCESS';
            if (normalized.includes('documentation') || normalized.includes('doc')) return 'DOCUMENTATION';
            return 'SALES';
          };

          departments.push({
            id: firstDept.id,
            type: nameToType(firstDept.name),
            name: firstDept.name,
          });
        }
      }

      return res.json({
        success: true,
        data: departments,
        meta: { count: departments.length }
      });

    } catch (error) {
      console.error('[AuthRouter] GET /me/departments failed:', error);
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch user departments.' }
      });
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

  // ─── GET /api/v1/auth/manifest ────────────────────────────────────
  /**
   * Protected — returns the authenticated user's compiled permission manifest.
   * Frontend uses this to populate the AuthContext and gate UI elements.
   *
   * Response shape: { "lead:create": "TEAM", "contact:view": "DEPARTMENT", ... }
   * The ScopeType value tells the frontend which scope the user has for each action.
   */
  router.get('/manifest', authMiddleware, (req: Request, res: Response) => {
    // permissions are already loaded by authMiddleware via Redis/DB
    const { permissions } = (req as AuthenticatedRequest).user;
    res.json(permissions);
  });

  return router;
}
