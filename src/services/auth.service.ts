import { PrismaClient, SessionStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import {
  AuthenticationFailedError,
  ResourceNotFoundError,
} from '../types/exceptions';
import { checkRefreshAttempts } from './auth/RateLimitService';
import { AuditService } from './audit.service';

export interface RefreshResult {
  accessToken: string;
}

const BCRYPT_COST = parseInt(process.env.BCRYPT_COST ?? '12', 10);
// reg #9: the ACCESS token is short-lived; the session-day lifetime must NOT leak into the
// access-token expiry (that was the multi-day-token bug). Single source of truth for the
// access-token TTL — signAccessToken() is the ONE signer used by login, signup/accept-invite
// (router delegates) AND refresh, so every access token is minted identically.
const ACCESS_TTL = (process.env.ACCESS_TTL ?? '15m') as SignOptions['expiresIn'];
// Session-row / refresh lifetime — matches the live login & signup/accept-invite behavior (7d).
// Distinct from ACCESS_TTL: this is how long the Session row (and thus the refresh token) lives.
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

// Fixed 32-byte buffer for constant-time dummy comparisons on the no-session / malformed-token
// path, so timing does not reveal which failure mode occurred.
const DUMMY_DIGEST = crypto.createHash('sha256').update('refresh-timing-dummy').digest();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JWT_SECRET = process.env.JWT_SECRET as string;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET not set');
  process.exit(1);
}

export class AuthService {
  private readonly auditService: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.auditService = new AuditService(prisma);
  }

  /**
   * Consolidated session creation — the ONLY place a Session row + refresh token is minted.
   * Used by login AND signup/accept-invite. Generates an opaque refresh token
   * "<sessionId>.<secret>" and persists ONLY sha256hex(secret) as refreshTokenHash
   * (never the secret itself, never bcrypt). The caller writes its own audit event.
   */
  async createSession(
    userId: string,
    tenantId: string
  ): Promise<{ sessionId: string; refreshToken: string }> {
    const secret = crypto.randomBytes(64).toString('hex');
    const refreshTokenHash = crypto.createHash('sha256').update(secret).digest('hex');

    const session = await this.prisma.session.create({
      data: {
        tenantId,
        userId,
        status: SessionStatus.ACTIVE,
        refreshTokenHash,
        expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
      },
    });

    return { sessionId: session.id, refreshToken: `${session.id}.${secret}` };
  }

  /**
   * Single-source access-token signer — same claims + TTL for login, signup, and refresh.
   * JWT payload is stateless: userId, tenantId, sessionId only.
   */
  signAccessToken(claims: { userId: string; tenantId: string; sessionId: string }): string {
    return jwt.sign(claims, JWT_SECRET, { expiresIn: ACCESS_TTL });
  }

  /**
   * Logout — transitions session from ACTIVE to REVOKED.
   * User-initiated action per state machine spec.
   */
  async logout(sessionId: string, tenantId: string, userId: string): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, tenantId, userId, deletedAt: { equals: null } }
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
        deletedAt: { equals: null }
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
   * Refresh — exchanges an opaque refresh token "<sessionId>.<secret>" for a NEW access token.
   *
   * Contract:
   * - Read-only on the session row (NO rotation) → 5 concurrent refreshes are safe.
   * - Uniform AuthenticationFailedError (401 AUTHENTICATION_FAILED) for EVERY failure mode
   *   (malformed / unknown-session / wrong-secret / expired / revoked / invalidated /
   *   deleted-or-suspended user) so nothing distinguishes them.
   * - Constant-time secret comparison over fixed 32-byte sha256 digest buffers; a dummy
   *   compare runs even when no session/valid hash is available (timing-oracle guard) and the
   *   length is guarded BEFORE timingSafeEqual so it can never throw.
   * - Rate limited per session-id AND per IP, fail-closed (throws before any DB work).
   * - Pre-existing sessions (bcrypt hash of discarded bytes, bare-sessionId token) fail here
   *   exactly as they do today — their stored hash is not a 32-byte hex digest.
   */
  async refresh(rawToken: string, ip?: string): Promise<RefreshResult> {
    const dot = rawToken.indexOf('.');
    const sessionId = dot > 0 ? rawToken.slice(0, dot) : '';
    const secret = dot > 0 ? rawToken.slice(dot + 1) : '';

    // Rate limit (fail-closed) BEFORE touching the DB — per session-id AND per IP.
    await checkRefreshAttempts(sessionId || 'unknown', ip ?? 'unknown');

    const session =
      sessionId && UUID_RE.test(sessionId)
        ? await this.prisma.session.findUnique({
            where: { id: sessionId },
            include: { user: { select: { status: true, deletedAt: true } } },
          })
        : null;

    // Constant-time secret check. presented is always a 32-byte digest; the stored hex is
    // decoded to a buffer and only used when it is exactly 32 bytes, otherwise we compare
    // against a fixed dummy so the timing profile is identical and then fail.
    const presented = crypto.createHash('sha256').update(secret).digest();
    let storedBuf = DUMMY_DIGEST;
    let storedLenOk = false;
    if (session) {
      const decoded = Buffer.from(session.refreshTokenHash, 'hex');
      if (decoded.length === 32) {
        storedBuf = decoded;
        storedLenOk = true;
      }
    }
    const secretMatches = crypto.timingSafeEqual(presented, storedBuf) && storedLenOk;

    const now = new Date();
    const sessionUsable =
      !!session &&
      !session.deletedAt &&
      (session.status === SessionStatus.CREATED || session.status === SessionStatus.ACTIVE) &&
      session.expiresAt > now;
    const userUsable =
      !!session?.user && !session.user.deletedAt && session.user.status === 'ACTIVE';

    if (!session || !secretMatches || !sessionUsable || !userUsable) {
      if (session) {
        // Best-effort failure audit (tenant known). Never include the secret or the hash.
        try {
          await this.auditService.log({
            tenantId: session.tenantId,
            eventType: 'TOKEN_REFRESH_FAILED',
            entityType: 'Session',
            entityId: session.id,
            actorUserId: session.userId,
            actorIp: ip,
            operation: 'REFRESH',
            payload: { sessionId: session.id, reason: 'refresh_rejected' },
          });
        } catch (e) {
          console.error('[REFRESH][AUDIT_DELIVERY_FAILURE]', e);
        }
      }
      throw new AuthenticationFailedError();
    }

    const accessToken = this.signAccessToken({
      userId: session.userId,
      tenantId: session.tenantId,
      sessionId: session.id,
    });

    await this.auditService.log({
      tenantId: session.tenantId,
      eventType: 'TOKEN_REFRESHED',
      entityType: 'Session',
      entityId: session.id,
      actorUserId: session.userId,
      actorIp: ip,
      operation: 'REFRESH',
      payload: { sessionId: session.id },
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
