import { PrismaClient, SessionStatus } from '@prisma/client';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
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
    /** Injected by permissionMiddleware — the resolved ABAC scope for the current route */
    scope?: string;
  };
}

const prisma = new PrismaClient();
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
        deletedAt: null,
      },
    });

    if (!session) {
      // Distinguish expired vs revoked for better error messages
      const anySession = await prisma.session.findFirst({
        where: { id: sessionId, deletedAt: null },
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

    // Touch lastActivityAt on every authenticated request
    await prisma.session.update({
      where: { id: sessionId },
      data: { lastActivityAt: new Date() },
    });

    // Promote CREATED → ACTIVE on first authenticated request
    if (session.status === SessionStatus.CREATED) {
      await prisma.session.update({
        where: { id: sessionId },
        data: { status: SessionStatus.ACTIVE },
      });
    }

    // Fetch user's team/department context for ABAC scope resolution
    const userRecord = await prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
      select: { teamId: true, departmentId: true },
    });

    // Load permission manifest (Redis-backed with DB fallback)
    const permissions = await permissionService.getPermissionManifest(userId, tenantId);

    (req as AuthenticatedRequest).user = {
      userId,
      tenantId,
      sessionId,
      teamId: userRecord?.teamId ?? null,
      departmentId: userRecord?.departmentId ?? null,
      permissions,
    };

    next();
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
    const scope = authedReq.user?.permissions[slug];

    if (!scope) {
      const err = new AuthorizationError();
      res.status(err.httpStatus).json({ code: err.code, message: err.message });
      return;
    }

    authedReq.user.scope = scope;
    next();
  };
}
