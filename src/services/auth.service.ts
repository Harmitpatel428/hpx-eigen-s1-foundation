import { PrismaClient, SessionStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import {
  AuthenticationFailedError,
  SessionExpiredError,
  SessionRevokedError,
  ResourceNotFoundError,
  TenantNotFoundError,
  ValidationError,
  AppException,
  RetryTag
} from '../types/exceptions';
import { AuditService } from './audit.service';

export interface LoginResult {
  accessToken: string;
  refreshToken?: string;
  sessionId: string;
  expiresAt: Date;
  userId: string;
  tenantId: string;
}

export interface RefreshResult {
  accessToken: string;
}

const BCRYPT_COST = parseInt(process.env.BCRYPT_COST ?? '12', 10);
const SESSION_LIFETIME_DAYS = parseInt(process.env.SESSION_LIFETIME_DAYS ?? '30', 10);

export class AuthService {
  private readonly auditService: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.auditService = new AuditService(prisma);
  }

  /**
   * Login — authenticates a user and creates a CREATED session.
   * Session transitions to ACTIVE on the first authenticated request (via middleware).
   */
  async login(
    email: string,
    password: string,
    meta: { ip?: string; userAgent?: string; deviceName?: string }
  ): Promise<LoginResult> {
    // Lookup user by email globally (emails are assumed unique for this phase)
    const user = await this.prisma.user.findFirst({
      where: {
        email,
        deletedAt: null
      }
    });

    if (!user) throw new AuthenticationFailedError();

    if (!user.emailVerified) {
      throw new AppException(
        'EMAIL_NOT_VERIFIED',
        'Please verify your email before logging in.',
        RetryTag.USER_ACTION_REQUIRED,
        403
      );
    }

    const actualTenantId = user.tenantId;

    // Constant-time password comparison
    const passwordValid = await bcrypt.compare(password, user.password);
    if (!passwordValid) throw new AuthenticationFailedError();

    // Generate secure refresh token, store only hash
    const refreshToken = crypto.randomBytes(64).toString('hex');
    const refreshTokenHash = await bcrypt.hash(refreshToken, BCRYPT_COST);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + SESSION_LIFETIME_DAYS);

    // Create session in CREATED state
    const session = await this.prisma.session.create({
      data: {
        tenantId: actualTenantId,
        userId: user.id,
        status: SessionStatus.CREATED,
        refreshTokenHash,
        expiresAt
        // Note: ipAddress, userAgent, deviceName require a schema migration to add.
        // Add these fields to Session model and run: npx prisma migrate dev --name add-session-meta
      }
    });

    const secret = process.env.JWT_SECRET!;
    const accessToken = jwt.sign(
      { sessionId: session.id, userId: user.id, tenantId: actualTenantId },
      secret,
      { expiresIn: `${SESSION_LIFETIME_DAYS}d` }
    );

    await this.auditService.log({
      tenantId: actualTenantId,
      eventType: 'USER_LOGIN',
      entityType: 'Session',
      entityId: session.id,
      actorUserId: user.id,
      actorIp: meta.ip,
      actorUserAgent: meta.userAgent,
      operation: 'CREATE',
      payload: { sessionId: session.id, email }
    });

    return { accessToken, sessionId: session.id, expiresAt, userId: user.id, tenantId: actualTenantId };
  }

  /**
   * Logout — transitions session from ACTIVE to REVOKED.
   * User-initiated action per state machine spec.
   */
  async logout(sessionId: string, tenantId: string, userId: string): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, tenantId, userId, deletedAt: null }
    });

    if (!session) throw new ResourceNotFoundError();

    // Terminal states cannot be revoked again
    const terminalStates: SessionStatus[] = [SessionStatus.EXPIRED, SessionStatus.REVOKED, SessionStatus.INVALIDATED];
    if (terminalStates.includes(session.status)) {
      return; // Idempotent
    }

    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.REVOKED,
        revokedAt: new Date()
      }
    });

    await this.auditService.log({
      tenantId,
      eventType: 'USER_LOGOUT',
      entityType: 'Session',
      entityId: sessionId,
      actorUserId: userId,
      operation: 'UPDATE',
      payload: { sessionId, action: 'REVOKED' }
    });
  }

  /**
   * Invalidate all sessions for a user (e.g. password reset, account suspension).
   * Transitions all CREATED/ACTIVE sessions to INVALIDATED.
   */
  async invalidateAllSessions(
    userId: string,
    tenantId: string,
    reason: string,
    actorUserId?: string
  ): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: {
        userId,
        tenantId,
        status: { in: [SessionStatus.CREATED, SessionStatus.ACTIVE] },
        deletedAt: null
      },
      data: {
        status: SessionStatus.INVALIDATED,
        invalidatedAt: new Date()
      }
    });

    await this.auditService.log({
      tenantId,
      eventType: 'ALL_SESSIONS_INVALIDATED',
      entityType: 'User',
      entityId: userId,
      actorUserId: actorUserId ?? userId,
      operation: 'UPDATE',
      payload: { reason, count: result.count }
    });

    return result.count;
  }

  /**
   * Refresh — validates the raw refresh token against the stored bcrypt hash.
   * Issues a new accessToken without creating a new session.
   *
   * Security notes:
   * - Session must be ACTIVE and not expired
   * - refreshToken is validated via constant-time bcrypt compare
   * - Replay attacks detected: if token hash doesn't match, throw AuthenticationFailedError
   */
  async refresh(
    sessionId: string,
    refreshToken: string,
    tenantId: string
  ): Promise<RefreshResult> {
    if (!refreshToken) throw new ValidationError('refreshToken is required.');

    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        tenantId,
        status: { in: [SessionStatus.CREATED, SessionStatus.ACTIVE] },
        expiresAt: { gt: new Date() },
        deletedAt: null
      },
      include: { user: { select: { id: true, status: true } } }
    });

    if (!session) throw new SessionExpiredError();

    // Constant-time comparison to prevent timing attacks
    const tokenValid = await bcrypt.compare(refreshToken, session.refreshTokenHash);
    if (!tokenValid) throw new AuthenticationFailedError();

    const secret = process.env.JWT_SECRET!;
    const accessToken = jwt.sign(
      { sessionId: session.id, userId: session.userId, tenantId },
      secret,
      { expiresIn: '15m' }
    );

    // Touch lastActivityAt
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { lastActivityAt: new Date() }
    });

    return { accessToken };
  }

  /**
   * Hash a password using bcrypt.
   */
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_COST);
  }
}
