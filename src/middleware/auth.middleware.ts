import { PrismaClient } from '@prisma/client';
import { Request, Response, NextFunction } from 'express';
import { TokenService } from '../services/token.service';
import { redisGet, redisSet, redisKeys } from '../redis';
import { PermissionService, PermissionManifest } from '../services/permission.service';
import {
  SessionRevokedError,
  AuthenticationFailedError,
  AuthorizationError,
  SessionExpiredError,
} from '../types/exceptions';
import { logger } from '../utils/logger';

export interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    tenantId: string;
    sessionId: string;
    teamId: string | null;
    activeDepartmentId: string | null;
    isSuperAdmin: boolean;
    permissions: PermissionManifest;
    /** Injected by permissionMiddleware — the resolved ABAC scope for the current route */
    scope?: string;
    /** Injected by permissionMiddleware in V2 mode — the full authorization decision */
    decision?: import('../types/authorization').AuthorizationDecision;
  };
}

const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);

/** Redis TTL for user context cache (teamId, departmentId). Match session lifetime. */
const USER_CONTEXT_TTL = 3600; // 1 hour

function userContextKey(userId: string): string {
  return `user:context:${userId}`;
}

interface UserContext {
  teamId: string | null;
  activeDepartmentId: string | null;
  isSuperAdmin: boolean;
}

/**
 * Fetch user's ABAC context (teamId, departmentId) from Redis.
 * Falls back to a single Prisma query on miss, then caches the result.
 * Eliminates the DB call from the hot path on all subsequent requests.
 */
async function getUserContext(userId: string, tenantId: string): Promise<UserContext> {
  const cacheKey = userContextKey(userId);
  const cached = await redisGet(cacheKey);

  if (cached !== null) {
    try {
      return JSON.parse(cached) as UserContext;
    } catch {
      // Corrupt — fall through to DB
    }
  }

  const userRecord = await prisma.user.findFirst({
    where: { id: userId, tenantId, deletedAt: null },
    select: { teamId: true, identityId: true },
  });

  let activeDepartmentId = null;
  if (userRecord?.identityId) {
    const membership = await prisma.organizationMembership.findFirst({
      where: { identityId: userRecord.identityId, tenantId },
      select: { id: true }
    });
    if (membership) {
      const assignment = await prisma.departmentAssignment.findFirst({
        where: { membershipId: membership.id, isPrimary: true }
      });
      activeDepartmentId = assignment?.departmentId ?? null;
    }
  }

  const superAdminRole = await prisma.userRole.findFirst({
    where: { userId, scopeType: 'ORGANIZATION' }
  });

  const context: UserContext = {
    teamId: userRecord?.teamId ?? null,
    activeDepartmentId,
    isSuperAdmin: !!superAdminRole,
  };

  // Cache even null values — null is a valid state
  await redisSet(cacheKey, JSON.stringify(context), USER_CONTEXT_TTL);

  return context;
}

/**
 * Core auth middleware — validates JWT + session per S1.8a Session State Machine spec.
 *
 * Hot path (all Redis cached):
 *   1. Verify RS256 JWT signature locally (CPU-bound, zero network)
 *   2. GET session:active:{sessionId}       → sub-millisecond Redis EXISTS check
 *   3. GET perm:manifest:{userId}           → O(1) permission manifest lookup
 *   4. GET user:context:{userId}            → O(1) teamId/departmentId lookup
 *
 * Zero Prisma queries on a fully warm cache.
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

    // 1. Verify JWT locally (CPU-bound, no network call)
    let payload: { sessionId: string; userId: string; tenantId: string };
    try {
      payload = TokenService.verifyAccessToken(token);
    } catch {
      throw new AuthenticationFailedError();
    }

    const { sessionId, userId, tenantId } = payload;

    // Validate Session via Redis (O(1) permission cache)
    const isSessionActive = await redisGet(redisKeys.sessionActive(payload.sessionId));

    if (!isSessionActive) {
      // CRITICAL FIX: DB Fallback
      logger.warn({ sessionId: payload.sessionId }, 'Redis cache miss for session. Falling back to DB.');
      const dbSession = await prisma.session.findUnique({
        where: { id: payload.sessionId }
      });
      
      if (!dbSession || dbSession.deletedAt !== null) {
        throw new SessionRevokedError();
      }
      
      const terminalStates = ['EXPIRED', 'REVOKED', 'INVALIDATED'];
      if (terminalStates.includes(dbSession.status)) {
        throw new SessionRevokedError();
      }
      
      // Repopulate Redis
      await redisSet(redisKeys.sessionActive(payload.sessionId), "1", 900);
    }

    // 3. Fetch permission manifest and user context in parallel (both Redis-backed)
    const [permissions, userContext] = await Promise.all([
      permissionService.getPermissionManifest(prisma, userId, tenantId),
      getUserContext(userId, tenantId),
    ]);

    (req as AuthenticatedRequest).user = {
      userId,
      tenantId,
      sessionId,
      teamId: userContext.teamId,
      activeDepartmentId: userContext.activeDepartmentId,
      isSuperAdmin: userContext.isSuperAdmin,
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
    logger.error({ err }, '[authMiddleware] Unhandled error');
    next(err);
  }
}

/**
 * Permission middleware factory — RBAC + ABAC enforcement.
 *
 * Usage: router.get('/', authMiddleware, permissionMiddleware('lead:view'), handler)
 *
 * Reads the manifest already loaded by authMiddleware (no additional I/O).
 * Injects req.user.scope for use in the controller's dynamic where-clause.
 * Calls next(err) on 403 so the Global Error Handler emits structured logs.
 */
export function permissionMiddleware(slug: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const authedReq = req as AuthenticatedRequest;
    const scopeOrDecision = authedReq.user?.permissions[slug];

    if (!scopeOrDecision) {
      next(new AuthorizationError());
      return;
    }

    if (typeof scopeOrDecision === 'string') {
      authedReq.user.scope = scopeOrDecision;
    } else {
      if (!scopeOrDecision.allowed) {
        next(new AuthorizationError());
        return;
      }
      authedReq.user.scope = scopeOrDecision.effectiveScope;
      authedReq.user.decision = scopeOrDecision;
    }

    next();
  };
}
