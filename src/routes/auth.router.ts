import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { AuthService } from '../services/auth.service';
import { AppException, ValidationError, InvitationAlreadyAcceptedError, RetryTag } from '../types/exceptions';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { emailService } from '../services/email.service';
import { PermissionService } from '../services/permission.service';
import { TokenService } from '../services/auth/TokenService';
import { checkLoginAttempts, checkResendLimit, checkInviteTokenLookup, checkAcceptAttempts } from '../services/auth/RateLimitService';
import { InvitationService } from '../services/invitation.service';
import { NotificationService } from '../services/notification.service';
import { AuditService } from '../services/audit.service';
import OrgInitService from '../services/OrgInitService';

export function createAuthRouter(prisma: PrismaClient): Router {
  const router = Router();
  const authService = new AuthService(prisma);
  const permissionService = new PermissionService(prisma);

  
  const tokenService = new TokenService(prisma);
  const invitationService = new InvitationService(prisma);
  const notificationService = new NotificationService(prisma);
  const auditService = new AuditService(prisma);
  const orgInitService = new OrgInitService(prisma);

  // ─── POST /api/auth/signup ────────────────────────────────────────
  router.post('/signup', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, companyName } = req.body;
      if (!email || !password || !companyName) throw new ValidationError('Email, password, and companyName are required.');
      if (password.length < 8) throw new ValidationError('Password must be at least 8 chars.');

      // Fast-path duplicate check outside the transaction (authoritative
      // check happens inside, under the advisory lock).
      const existingUser = await prisma.user.findFirst({ where: { email } });
      if (existingUser) return res.status(409).json({ code: 'USER_EXISTS', message: 'Email already registered' });

      const hashedPassword = await bcrypt.hash(password, 12);

      let verificationTokenValue = '';

      // Everything — Tenant, User, verification token, admin role assignment,
      // RBAC scaffolding, audit entries — commits atomically or not at all.
      // There is no intermediate state where the org exists without its admin.
      await prisma.$transaction(async (tx) => {
        // Serialize concurrent signups of the same email. The schema's user
        // uniqueness is composite (tenantId, email) by design — invitations
        // legitimately place one person in multiple tenants — so a global
        // unique index is not an option; this lock + re-check is the guard.
        // $executeRaw (not $queryRaw): the lock function returns VOID, which
        // $queryRaw cannot deserialize ("Failed to deserialize column of type 'void'").
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${email}))`;

        const duplicate = await tx.user.findFirst({ where: { email } });
        if (duplicate) {
          throw new AppException('USER_EXISTS', 'Email already registered', RetryTag.USER_ACTION_REQUIRED, 409);
        }

        const tenant = await tx.tenant.create({ data: { name: companyName } });

        const user = await tx.user.create({
          data: {
            email,
            password: hashedPassword,
            tenantId: tenant.id,
            emailVerified: null // CRITICAL: Start unverified
          }
        });

        // Verification token (row is data → belongs in the transaction; the
        // email itself is sent after commit below).
        const token = tokenService.generateToken();
        const tokenHash = tokenService.hashToken(token);
        verificationTokenValue = token;

        await tx.verificationToken.create({
          data: {
            userId: user.id,
            token,
            tokenHash,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
          }
        });

        // Audit entry chained onto the global hash chain
        const lastAudit = await tx.auditLog.findFirst({
          orderBy: { createdAt: 'desc' },
          select: { currentHash: true },
        });
        const previousHash = lastAudit?.currentHash ?? null;
        const currentHash = crypto
          .createHash('sha256')
          .update(JSON.stringify({
            eventType: 'USER_REGISTERED', entityType: 'User', entityId: user.id,
            operation: 'CREATE', payload: { email, emailVerified: false },
          }) + (previousHash || ''))
          .digest('hex');

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            eventType: 'USER_REGISTERED',
            entityType: 'User',
            entityId: user.id,
            actorUserId: user.id,
            operation: 'CREATE',
            payload: { email, emailVerified: false },
            previousHash,
            currentHash,
          }
        });

        // Admin role + department/team + role assignment for THIS user,
        // inside the same transaction. Throws on failure → full rollback.
        await orgInitService.initializeOrgRBACWithinTx(tx, tenant.id, user.id, {
          previousAuditHash: currentHash,
        });

        // Org fully provisioned — leave PROVISIONING.
        await tx.tenant.update({ where: { id: tenant.id }, data: { status: 'ACTIVE' } });
      }).catch((err) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new AppException('USER_EXISTS', 'Email already registered', RetryTag.USER_ACTION_REQUIRED, 409);
        }
        throw err;
      });

      // External side effect — strictly AFTER commit, never inside the
      // transaction. Failure to send is logged; the user can request a resend
      // via /resend-verification.
      emailService
        .sendVerificationEmail(email, verificationTokenValue)
        .catch((e) => console.error('Email send failed', e));

      res.status(201).json({ success: true, message: 'Account created. Please verify your email.', email });
    } catch (err) { next(err); }
  });

  // ─── POST /api/auth/login ─────────────────────────────────────────
  router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;
      
      // Validation
      if (!email || !password) {
        return res.status(400).json({ success: false, code: 'INVALID_INPUT', message: 'Email and password required' });
      }

      const attempts = await checkLoginAttempts(email);
      if (attempts > 5) return res.status(429).json({ success: false, error: { message: 'Too many attempts' } });
      
      // User lookup (INCLUDE emailVerified)
      console.log('[LOGIN] Looking up user:', email);
      const user = await prisma.user.findFirst({
        where: { email: email.toLowerCase().trim(), deletedAt: null },
        include: { tenant: { select: { id: true, name: true } } }
      });
      
      if (!user) {
        console.log('[LOGIN] User not found');
        return res.status(401).json({ 
          success: false,
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password.'
        });
      }
      
      // Password validation
      if (!user.password) {
        console.error('[LOGIN] User has no password hash:', user.id);
        return res.status(401).json({
          success: false,
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password.'
        });
      }
      
      const isValid = await bcrypt.compare(password, user.password);
      console.log('[LOGIN] Password validation:', isValid);
      
      if (!isValid) {
        console.log('[LOGIN] Invalid password');
        return res.status(401).json({
          success: false,
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password.'
        });
      }
      
      // EMAIL VERIFICATION CHECK (CRITICAL)
      console.log('[LOGIN] emailVerified:', user.emailVerified, 'Type:', typeof user.emailVerified);
      
      if (!user.emailVerified) {
        console.log('[LOGIN] Email not verified');
        return res.status(403).json({
          success: false,
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Email address not verified. Check your inbox or request resend.',
          email: user.email,
          resendAvailable: true
        });
      }
      
      // Fetch all needed data BEFORE response
      const [permissions] = await Promise.all([
        permissionService.getPermissionManifest(user.id, user.tenantId).catch(() => ({}))
      ]);

      // EMAIL VERIFIED — Create session
      console.log('[LOGIN] All checks passed, creating session...');

      const session = await prisma.session.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          status: 'ACTIVE',
          refreshTokenHash: await bcrypt.hash(crypto.randomBytes(64).toString('hex'), 12),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        }
      });
      
      const jwtToken = jwt.sign(
        { userId: user.id, tenantId: user.tenantId, sessionId: session.id },
        process.env.JWT_SECRET!,
        { expiresIn: '7d' }
      );
      
      // Audit
      await prisma.auditLog.create({
        data: {
          tenantId: user.tenantId,
          eventType: 'USER_LOGIN',
          entityType: 'Session',
          entityId: session.id,
          actorUserId: user.id,
          operation: 'CREATE',
          payload: { sessionId: session.id },
          currentHash: crypto.randomBytes(32).toString('hex')
        }
      });
      
      console.log('[LOGIN] Success');

      return res.status(200).json({
        success: true,
        data: {
          accessToken: jwtToken,
          refreshToken: session.id, // sessionId as refresh identifier
          user: { id: user.id, email: user.email, tenantId: user.tenantId },
          organization: { id: user.tenant.id, name: user.tenant.name },
          permissions,
          sessionId: session.id
        }
      });
      
    } catch (error) {
      console.error('[LOGIN] Unhandled error:', error);
      next(error);
    }
  });

  // ─── POST /api/auth/verify-email ──────────────────────────────────
  router.post('/verify-email', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = req.body;
      
      console.log('[VERIFY-EMAIL] Request: token length =', token?.length);
      
      if (!token || typeof token !== 'string') {
        console.log('[VERIFY-EMAIL] Invalid token format');
        return res.status(400).json({
          success: false,
          code: 'INVALID_TOKEN',
          message: 'Verification link invalid or expired.'
        });
      }
      
      // Hash token for DB lookup
      // Using tokenService for hashing if crypto is unavailable or to maintain standard.
      // But we will use the raw crypto as specified for explicit tracing.
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      console.log('[VERIFY-EMAIL] Looking up token hash:', tokenHash.substring(0, 20));
      
      // Find verification token
      const verificationToken = await prisma.verificationToken.findFirst({
        where: {
          tokenHash,
          status: 'PENDING',
          expiresAt: { gt: new Date() },
          deletedAt: null
        },
        include: { user: true }
      });
      
      if (!verificationToken) {
        console.log('[VERIFY-EMAIL] Token not found, expired, or used');
        return res.status(400).json({
          success: false,
          code: 'INVALID_TOKEN',
          message: 'Verification link invalid or expired. Request a new one.'
        });
      }
      
      console.log('[VERIFY-EMAIL] Token found, verifying user:', verificationToken.userId);
      
      // Atomic transaction: update user + invalidate token
      const result = await prisma.$transaction(async (tx) => {
        // Update user
        const user = await tx.user.update({
          where: { id: verificationToken.userId },
          data: {
            emailVerified: new Date(),
            verifiedAt: new Date()
          }
        });
        
        console.log('[VERIFY-EMAIL] User verified, emailVerified:', user.emailVerified);
        
        // Mark token as used
        await tx.verificationToken.update({
          where: { id: verificationToken.id },
          data: {
            status: 'USED',
            usedAt: new Date(),
            deletedAt: new Date()
          }
        });
        
        // Invalidate all other tokens for this user
        await tx.verificationToken.updateMany({
          where: {
            userId: verificationToken.userId,
            id: { not: verificationToken.id },
            deletedAt: null
          },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(),
            deletedAt: new Date()
          }
        });
        
        // Audit
        await tx.auditLog.create({
          data: {
            tenantId: user.tenantId,
            eventType: 'EMAIL_VERIFIED',
            entityType: 'User',
            entityId: user.id,
            actorUserId: user.id,
            operation: 'UPDATE',
            payload: { email: user.email },
            currentHash: crypto.randomBytes(32).toString('hex')
          }
        });
        
        return user;
      });
      
      console.log('[VERIFY-EMAIL] Verification complete');

      return res.status(200).json({
        success: true,
        data: {
          message: 'Email verified successfully. You can now login.',
          email: result.email
        }
      });
      
    } catch (error) {
      console.error('[VERIFY-EMAIL] Error:', error);
      next(error);
    }
  });

  // ─── POST /api/auth/resend-verification ───────────────────────────
  router.post('/resend-verification', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body;
      const user = await prisma.user.findFirst({ where: { email } });
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.emailVerified != null) return res.status(409).json({ error: 'Email already verified' });

      const attempts = await checkResendLimit(email);
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

      await emailService.sendPasswordResetEmail(user.email, resetToken).catch(e =>
        console.error('[FORGOT-PASSWORD] Email send failed:', e)
      );
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

      // Security email + notification (best-effort, after commit)
      await emailService.sendPasswordChangedEmail(resetToken.user.email).catch(e =>
        console.error('[RESET-PASSWORD] Security email failed:', e)
      );
      await notificationService.create({
        tenantId: resetToken.user.tenantId,
        recipientUserId: resetToken.userId,
        type: 'PASSWORD_RESET_COMPLETED',
        title: 'Password reset completed',
        message: 'Your password was reset successfully. All active sessions have been revoked.',
      }).catch(e => console.error('[RESET-PASSWORD] Notification failed:', e));

      try {
        await auditService.log({
          tenantId: resetToken.user.tenantId,
          eventType: 'PASSWORD_RESET_COMPLETED',
          entityType: 'User',
          entityId: resetToken.userId,
          operation: 'PASSWORD_RESET',
          payload: { tokenId: resetToken.id },
        });
      } catch (e) {
        console.error('[AUDIT_DELIVERY_FAILURE]', e);
      }

      res.json({ message: 'Password reset successfully. Please login.' });
    } catch (err) { next(err); }
  });

  // ─── POST /api/auth/change-password ────────────────────────────────
  router.post('/change-password', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };

      if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, code: 'INVALID_INPUT', message: 'currentPassword and newPassword are required.' });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ success: false, code: 'INVALID_INPUT', message: 'New password must be at least 8 characters.' });
      }

      const user = await prisma.user.findFirst({
        where: { id: userId, tenantId, deletedAt: null },
        select: { id: true, email: true, tenantId: true, password: true },
      });
      if (!user) return res.status(404).json({ success: false, code: 'USER_NOT_FOUND' });

      const valid = await bcrypt.compare(currentPassword, user.password);
      if (!valid) {
        return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' });
      }

      const hashed = await bcrypt.hash(newPassword, 12);
      await prisma.user.update({ where: { id: userId }, data: { password: hashed } });

      // Security email + notification (best-effort)
      await emailService.sendPasswordChangedEmail(user.email).catch(e =>
        console.error('[CHANGE-PASSWORD] Security email failed:', e)
      );
      await notificationService.create({
        tenantId,
        recipientUserId: userId,
        type: 'PASSWORD_CHANGED',
        title: 'Password changed',
        message: 'Your password was changed successfully. If you did not do this, contact your administrator immediately.',
      }).catch(e => console.error('[CHANGE-PASSWORD] Notification failed:', e));

      try {
        await auditService.log({
          tenantId,
          eventType: 'PASSWORD_CHANGED',
          entityType: 'User',
          entityId: userId,
          actorUserId: userId,
          actorIp: req.ip,
          actorUserAgent: req.headers['user-agent'],
          operation: 'PASSWORD_CHANGE',
          payload: {},
        });
      } catch (e) {
        console.error('[AUDIT_DELIVERY_FAILURE]', e);
      }

      res.json({ success: true, message: 'Password changed successfully.' });
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

  // ─── GET /api/v1/auth/invite/:token ──────────────────────────────
  // Public, read-only — no DB mutation under any circumstance.
  // Rate limited to prevent token enumeration.
  router.get('/invite/:token', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      await checkInviteTokenLookup(ip);

      const rawToken = req.params['token'];
      if (!rawToken || typeof rawToken !== 'string') {
        return res.status(404).json({ code: 'INVITATION_NOT_FOUND', message: 'Invitation not found.' });
      }

      const tokenHash = tokenService.hashToken(rawToken);
      const invitation = await prisma.userInvitation.findFirst({
        where: { token: tokenHash, deletedAt: null },
        include: { role: { select: { name: true } } }
      });

      if (!invitation) {
        return res.status(404).json({ code: 'INVITATION_NOT_FOUND', message: 'Invitation not found.' });
      }

      if (invitation.status === 'REVOKED') {
        return res.status(410).json({ code: 'INVITATION_REVOKED', message: 'This invitation has been revoked.' });
      }

      if (invitation.status === 'ACCEPTED') {
        return res.status(410).json({ code: 'INVITATION_ALREADY_ACCEPTED', message: 'This invitation has already been accepted.' });
      }

      if (invitation.status === 'EXPIRED' || invitation.expiresAt < new Date()) {
        return res.status(410).json({ code: 'INVITATION_EXPIRED', message: 'This invitation has expired.' });
      }

      // Mask email: first char + *** + @domain
      const atIdx = invitation.email.indexOf('@');
      const maskedEmail = invitation.email[0] + '***' + invitation.email.slice(atIdx);

      // Check if an ACTIVE user with this email already exists in the tenant
      const existingUser = await prisma.user.findFirst({
        where: { email: invitation.email, tenantId: invitation.tenantId, status: 'ACTIVE', deletedAt: null }
      });

      return res.json({
        email: maskedEmail,
        roleName: invitation.role.name,
        expiresAt: invitation.expiresAt.toISOString(),
        userExists: existingUser !== null
      });
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/v1/auth/accept-invite ─────────────────────────────
  // Public — accepts invitation, creates user if new, creates session.
  router.post('/accept-invite', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      await checkAcceptAttempts(ip);

      const { token, password } = req.body as { token?: string; password?: string };
      if (!token || typeof token !== 'string') throw new ValidationError('token is required.');

      const tokenHash = tokenService.hashToken(token);

      const { userId, tenantId, invitationId } = await invitationService.acceptInvitation(
        tokenHash,
        { password }
      );

      // Load user + tenant for response (same shape as login)
      const user = await prisma.user.findFirst({
        where: { id: userId },
        include: { tenant: { select: { id: true, name: true } } }
      });
      if (!user) throw new Error('User not found after acceptance — data integrity error');

      const [permissions] = await Promise.all([
        permissionService.getPermissionManifest(userId, tenantId).catch(() => ({}))
      ]);

      const session = await prisma.session.create({
        data: {
          tenantId,
          userId,
          status: 'ACTIVE',
          refreshTokenHash: await bcrypt.hash(crypto.randomBytes(64).toString('hex'), 12),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        }
      });

      const jwtToken = jwt.sign(
        { userId, tenantId, sessionId: session.id },
        process.env.JWT_SECRET!,
        { expiresIn: '7d' }
      );

      await prisma.auditLog.create({
        data: {
          tenantId,
          eventType: 'INVITATION_SESSION_CREATED',
          entityType: 'Session',
          entityId: session.id,
          actorUserId: userId,
          operation: 'CREATE',
          payload: { invitationId, sessionId: session.id },
          currentHash: crypto.randomBytes(32).toString('hex')
        }
      });

      return res.status(200).json({
        success: true,
        data: {
          accessToken: jwtToken,
          refreshToken: session.id,
          user: { id: user.id, email: user.email, tenantId: user.tenantId },
          organization: { id: user.tenant!.id, name: user.tenant!.name },
          permissions,
          sessionId: session.id
        }
      });
    } catch (err) {
      if (err instanceof InvitationAlreadyAcceptedError) {
        return res.status(409).json({ code: err.code, message: err.message });
      }
      next(err);
    }
  });

  return router;
}
