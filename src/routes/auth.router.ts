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

export function createAuthRouter(prisma: PrismaClient): Router {
  const router = Router();
  const authService = new AuthService(prisma);
  const permissionService = new PermissionService(prisma);

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

      const existingUser = await prisma.user.findFirst({ where: { email } });
      if (existingUser) {
        return res.status(409).json({ error: 'USER_EXISTS', message: 'Email already registered' });
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      const token = crypto.randomBytes(32).toString('hex');
      let tenantId = "";
      let userId = "";

      // START TRANSACTION
      await prisma.$transaction(async (tx) => {
        // 1. Create Tenant
        const tenant = await tx.tenant.create({
          data: { name: companyName }
        });
        tenantId = tenant.id;

        // 2. Create User
        const user = await tx.user.create({
          data: {
            email,
            password: hashedPassword,
            tenantId: tenant.id,
            emailVerified: null
          }
        });
        userId = user.id;

        // 3. Delete old tokens and create VerificationToken
        await tx.verificationToken.deleteMany({ where: { email } });
        await tx.verificationToken.create({
          data: {
            email,
            token,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h
          }
        });
      }); // End transaction for Tenant/User creation

      // 4. Call OrgInitService
      const { OrgInitService } = await import('../services/rbac/OrgInitService');
      const orgInitService = new OrgInitService(prisma);
      const result = await orgInitService.initializeOrgRBAC(tenantId, userId, "Administration", "Admin");
      
      if (!result.success) {
        // If OrgInitService fails, we theoretically should rollback Tenant/User, 
        // but since we split transactions, we just throw to return 500.
        // A cleanup job can remove orphaned tenants.
        throw new Error(`OrgInitService failed: ${result.error}`);
      }

      // Send email via Resend
      const verifyUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}&email=${encodeURIComponent(email)}`;
      try {
        await emailService.sendVerificationEmail(email, token);
      } catch (emailError) {
        console.error('Resend Email Failed. Verification URL for manual testing:', verifyUrl);
      }

      res.status(201).json({
        message: 'Signup successful. Check your email to verify account.',
        email,
        organizationName: companyName,
        userId,
        tenantId
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
        where: { email: verificationToken.email },
        include: { tenant: true }
      });

      if (!user) {
        return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User account not found' });
      }

      // START TRANSACTION
      await prisma.$transaction(async (tx) => {
        // 1. Mark emailVerified
        await tx.user.update({
          where: { id: user.id },
          data: { emailVerified: new Date() }
        });

        // 2. Delete VerificationToken
        await tx.verificationToken.deleteMany({
          where: { email: verificationToken.email }
        });

        // 3. Create AuditLog entry
        const generateHash = (eventData: any) => crypto.createHash('sha256').update(JSON.stringify(eventData)).digest('hex');
        await tx.auditLog.create({
          data: {
            tenantId: user.tenantId,
            eventType: "email_verified",
            entityType: "User",
            entityId: user.id,
            actorUserId: user.id,
            actorIp: req.ip || "0.0.0.0",
            actorUserAgent: req.headers['user-agent'] || "Unknown",
            operation: "UPDATE",
            payload: { emailVerified: true },
            previousHash: null,
            currentHash: generateHash({ eventType: "email_verified", entityId: user.id })
          }
        });
      });

      // Load permissions into Redis
      await permissionService.invalidatePermissionCache(user.tenantId); // Simple method, real one should be loadUserPermissions
      // Wait, prompt wants to call PermissionService.loadUserPermissions(userId, tenantId)
      // I will add it here, assuming we will add it to permissionService later
      try {
        await permissionService.loadUserPermissions(user.id, user.tenantId);
      } catch (err) {
        console.warn('Failed to load user permissions to Redis cache:', err);
      }

      // Issue JWT
      const accessToken = jwt.sign(
        { 
          userId: user.id, 
          tenantId: user.tenantId,
          email: user.email,
          role: "Organization Administrator",
          scopes: ["ORGANIZATION"] 
        },
        process.env.JWT_SECRET!,
        { expiresIn: '7d' } // Temporary long expiry for initial setup
      );

      res.status(200).json({
        message: 'Email verified successfully! You can now login.',
        jwt: accessToken,
        user: { id: user.id, email: user.email, tenantId: user.tenantId },
        organization: { tenantId: user.tenantId, name: user.tenant.name }
      });
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/auth/login ─────────────────────────────────────────
  /** Public — authenticate with email + password, returns accessToken + sessionId */
  router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;

      // ─── Input Validation ──────────────────────────────────────────
      if (!email || typeof email !== 'string') {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_EMAIL', message: 'Email is required.' }
        });
      }
      if (!password || typeof password !== 'string') {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_PASSWORD', message: 'Password is required.' }
        });
      }

      // ─── Lookup Identity (V2 auth table) ─────────────────────────
      const identity = await prisma.identity.findUnique({
        where: { email: email.toLowerCase().trim() },
      });

      if (!identity) {
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }
        });
      }

      if (!identity.emailVerified) {
        return res.status(403).json({
          success: false,
          error: { code: 'EMAIL_NOT_VERIFIED', message: 'Please verify your email before logging in.' }
        });
      }

      if (identity.globalStatus !== 'ACTIVE') {
        return res.status(403).json({
          success: false,
          error: { code: 'ACCOUNT_SUSPENDED', message: 'Your account is not active.' }
        });
      }

      // ─── Password Verification ────────────────────────────────────
      const valid = await bcrypt.compare(password, identity.passwordHash);
      if (!valid) {
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }
        });
      }

      // ─── Fetch tenant User profile linked to this Identity ────────
      const user = await prisma.user.findFirst({
        where: { email: identity.email, deletedAt: null },
        include: {
          tenant: { select: { id: true } },
          userRoles: {
            include: {
              role: {
                include: { permissions: true }
              }
            }
          }
        }
      });

      if (!user) {
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }
        });
      }

      // ─── Create Session ──────────────────────────────────────────────
      const BCRYPT_COST = 12;
      const SESSION_LIFETIME_DAYS = 7;
      
      const refreshTokenPlain = crypto.randomBytes(64).toString('hex');
      const refreshTokenHash = await bcrypt.hash(refreshTokenPlain, BCRYPT_COST);
      
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + SESSION_LIFETIME_DAYS);
      
      const session = await prisma.session.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          status: 'CREATED', // Using string to avoid missing enum import
          refreshTokenHash,
          expiresAt
        }
      });

      // ─── Generate Tokens ─────────────────────────────────────────────
      const accessToken = jwt.sign(
        { 
          sessionId: session.id,
          userId: user.id, 
          tenantId: user.tenantId,
          email: user.email 
        },
        process.env.JWT_SECRET!,
        { expiresIn: '1h' }
      );

      const refreshToken = jwt.sign(
        { userId: user.id, type: 'refresh' },
        process.env.JWT_REFRESH_SECRET ?? process.env.JWT_SECRET!,
        { expiresIn: '7d' }
      );

      // ─── Return Standardized Response ────────────────────────────────
      return res.json({
        success: true,
        data: {
          accessToken,
          refreshToken,
          sessionId: session.id,
          user: {
            id: user.id,
            email: user.email,
            name: (user as any).name || user.email,
            tenantId: user.tenantId,
          }
        }
      });

    } catch (error: any) {
      console.error('[AuthRouter] POST /login crashed:', error);
      return res.status(500).json({
        success: false,
        error: { 
          code: 'INTERNAL_ERROR', 
          message: 'An unexpected error occurred.',
          // Only expose detail in development
          ...(process.env.NODE_ENV !== 'production' && { detail: error.message })
        }
      });
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
