import { SessionStatus } from '@prisma/client';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { prisma } from '../db';
import { requestContextStorage, RequestContext } from '../context/request-context';
import { PermissionService, PermissionManifest } from '../services/permission.service';
import {
  SessionExpiredError,
  SessionRevokedError,
  AuthenticationFailedError,
  AuthorizationError,
} from '../types/exceptions';

export interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    tenantId: string;
    sessionId: string;
    teamId: string | null;
    departmentId: string | null;
    permissions: PermissionManifest;
    /** Set when this session was created via admin impersonation */
    impersonatedByUserId: string | null;
    /** Injected by permissionMiddleware — the resolved ABAC scope for the current route */
    scope?: string;
    /** Injected by permissionMiddleware in V2 mode — the full authorization decision */
    decision?: import('../types/authorization').AuthorizationDecision;
  };
}

const permissionService = new PermissionService(prisma);

/**
 * Core auth middleware — validates JWT + session per S1.8a Session State Machine spec.
 *
 * On success, attaches to req.user:
 *   - userId, tenantId, sessionId   (from JWT)
 *   - teamId, departmentId          (from User record — needed by buildOwnerFilter)
 *   - permissions                   (compiled manifest from Redis/DB)
 *
 * JWT payload is STATELESS: contains ONLY userId, tenantId, sessionId.
 * Permissions are NEVER embedded in the JWT.
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ code: 'MISSING_TOKEN', message: 'Authorization token required.' });
      return;
    }

    const token = authHeader.slice(7);
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET not configured');
    }

    // Verify and decode JWT (stateless: userId, tenantId, sessionId only)
    let payload: { sessionId: string; userId: string; tenantId: string };
    try {
      payload = jwt.verify(token, secret) as typeof payload;
    } catch {
      throw new AuthenticationFailedError();
    }

    const { sessionId, userId, tenantId } = payload;

    // Validate session per state machine spec:
    // Must be ACTIVE/CREATED, not expired, not soft-deleted, tenant-scoped
    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        tenantId,
        userId,
        status: { in: [SessionStatus.ACTIVE, SessionStatus.CREATED] },
        expiresAt: { gt: new Date() },
        deletedAt: { equals: null },
      },
    });

    if (!session) {
      // Distinguish expired vs revoked for better error messages
      const anySession = await prisma.session.findFirst({
        where: { id: sessionId, deletedAt: { equals: null } },
        select: { status: true, expiresAt: true },
      });

      if (!anySession) throw new AuthenticationFailedError();

      if (
        anySession.status === SessionStatus.EXPIRED ||
        anySession.expiresAt <= new Date()
      ) {
        throw new SessionExpiredError();
      }

      if (
        anySession.status === SessionStatus.REVOKED ||
        anySession.status === SessionStatus.INVALIDATED
      ) {
        throw new SessionRevokedError();
      }

      throw new AuthenticationFailedError();
    }

    // Touch lastActivityAt, but throttle: only write when it has gone stale (>60s).
    // Keeps the per-request write off the hot path for active sessions while
    // preserving ~60s-granular activity tracking (the only reader is the session
    // list display, sessions.router.ts).
    const ACTIVITY_TOUCH_MS = 60_000;
    const lastActivity = session.lastActivityAt?.getTime() ?? 0;
    const touch =
      Date.now() - lastActivity > ACTIVITY_TOUCH_MS
        ? prisma.session.update({
            where: { id: sessionId },
            data: { lastActivityAt: new Date() },
          })
        : Promise.resolve();

    // Promote CREATED → ACTIVE on first authenticated request (rare)
    const promote =
      session.status === SessionStatus.CREATED
        ? prisma.session.update({
            where: { id: sessionId },
            data: { status: SessionStatus.ACTIVE },
          })
        : Promise.resolve();

    // The user context fetch and the permission manifest are independent of each
    // other and of the two session writes — run them all concurrently instead of
    // paying 4 sequential round trips.
    const [userRecord, permissions] = await Promise.all([
      prisma.user.findFirst({
        where: { id: userId, tenantId, deletedAt: { equals: null } },
        select: { teamId: true, departmentId: true },
      }),
      permissionService.getPermissionManifest(userId, tenantId),
      promote,
      touch,
    ]);

    (req as AuthenticatedRequest).user = {
      userId,
      tenantId,
      sessionId,
      teamId: userRecord?.teamId ?? null,
      departmentId: userRecord?.departmentId ?? null,
      permissions,
      impersonatedByUserId: (session as any).impersonatedByUserId ?? null,
    };

    const requestContext: RequestContext = {
      identityId: userId,
      membershipId: '',
      tenantId,
      sessionId,
      correlationId: (req.headers['x-correlation-id'] as string) || crypto.randomUUID(),
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      requestedAt: new Date(),
    };

    requestContextStorage.run(requestContext, () => {
      next();
    });
  } catch (err: unknown) {
    if (
      err instanceof AuthenticationFailedError ||
      err instanceof SessionExpiredError ||
      err instanceof SessionRevokedError
    ) {
      const e = err as { httpStatus: number; code: string; message: string };
      res.status(e.httpStatus).json({ code: e.code, message: e.message });
      return;
    }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal server error.' });
  }
}

/**
 * Permission middleware factory — RBAC + ABAC enforcement.
 *
 * Usage: router.get('/', authMiddleware, permissionMiddleware('lead:view'), handler)
 *
 * Checks that the authenticated user has the required permission slug.
 * If present, injects req.user.scope (the ScopeType value) for use in
 * the controller's dynamic where-clause building.
 * Returns 403 if the permission is absent.
 */
export function permissionMiddleware(slug: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authedReq = req as AuthenticatedRequest;
    const scopeOrDecision = authedReq.user?.permissions[slug];

    if (!scopeOrDecision) {
      const err = new AuthorizationError();
      res.status(err.httpStatus).json({ code: err.code, message: err.message });
      return;
    }

    if (typeof scopeOrDecision === 'string') {
      authedReq.user.scope = scopeOrDecision;
    } else {
      if (!scopeOrDecision.allowed) {
        const err = new AuthorizationError();
        res.status(err.httpStatus).json({ code: err.code, message: err.message });
        return;
      }
      authedReq.user.scope = scopeOrDecision.effectiveScope;
      authedReq.user.decision = scopeOrDecision;
    }

    next();
  };
}
