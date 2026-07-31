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

      // Fetch all global permissions
      const allPermissions = await prisma.permission.findMany();

      // Ensure 'Organization Admin' role exists for this tenant
      let adminRole = await prisma.role.findFirst({
        where: { tenantId: tenant.id, name: 'Organization Admin' }
      });
      if (!adminRole) {
        adminRole = await prisma.role.create({
          data: { tenantId: tenant.id, name: 'Organization Admin', isSystem: true }
        });

        if (allPermissions.length > 0) {
          await prisma.rolePermission.createMany({
            data: allPermissions.map(p => ({
              roleId: adminRole!.id,
              permissionId: p.id
            }))
          });
        }
      }

      // Assign ADMIN role to the user with scopeType: 'ORGANIZATION'
      await prisma.userRole.create({
        data: { userId: user.id, roleId: adminRole!.id, scopeType: 'ORGANIZATION' }
      });

      // Call permissionService.invalidatePermissionCache(tenant.id) to ensure the cache is fresh
      await permissionService.invalidatePermissionCache(tenant.id);

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

      // Attempt to send email, but don't crash the signup if it fails
      const verifyUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
      try {
        await emailService.sendVerificationEmail(email, token);
      } catch (emailError) {
        console.error('Resend Email Failed. Verification URL for manual testing:', verifyUrl);
      }

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

      // ─── Fetch User (defensive: try multiple password field names) ───
      const user = await prisma.user.findFirst({
        where: { email: email.toLowerCase().trim() },
        include: {
          tenant: { select: { id: true } },
          userRoles: {
            include: {
              role: {
                include: {
                  permissions: true
                }
              }
            }
          }
        }
      });

      if (!user) {
        // Same response as invalid password to prevent user enumeration
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }
        });
      }

      // ─── Password Verification (handles multiple field names) ─────────
      const passwordHash = (user as any).passwordHash 
        ?? (user as any).password 
        ?? (user as any).hashedPassword;

      if (!passwordHash) {
        console.error(`[Auth] User ${user.id} has no password hash field`);
        return res.status(500).json({
          success: false,
          error: { code: 'AUTH_CONFIG_ERROR', message: 'Authentication misconfiguration.' }
        });
      }

      const valid = await bcrypt.compare(password, passwordHash);
      if (!valid) {
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }
        });
      }

      // ─── Generate Tokens ─────────────────────────────────────────────
      const accessToken = jwt.sign(
        { 
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
          sessionId: crypto.randomBytes(16).toString('hex'),
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
