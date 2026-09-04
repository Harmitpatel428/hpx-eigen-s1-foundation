import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, SessionStatus } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ResourceNotFoundError } from '../types/exceptions';

// reg #10 (WP-1 PR-1): admin impersonation removed here. The unrestricted `/impersonate`
// and `/exit-impersonation` endpoints (V10) are gone; the replacement is the scoped,
// time-boxed support_access_grant [NEXT]. Session.impersonatedByUserId is retained
// (never written) until the Phase-12 support-access cutover.

export function createSessionsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // All session routes require authentication
  router.use(authMiddleware);

  // ─── GET /api/sessions ────────────────────────────────────────────
  /**
   * List the authenticated user's own active sessions.
   * Returns: [{ id, status, createdAt, lastActivityAt, expiresAt }]
   */
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId, sessionId: currentSessionId } = (req as AuthenticatedRequest).user;

      const sessions = await prisma.session.findMany({
        where: {
          userId,
          tenantId,
          status: { in: [SessionStatus.CREATED, SessionStatus.ACTIVE] },
          expiresAt: { gt: new Date() },
          deletedAt: { equals: null }
        },
        select: {
          id: true,
          status: true,
          createdAt: true,
          lastActivityAt: true,
          expiresAt: true
        },
        orderBy: { createdAt: 'desc' }
      });

      // Mark the caller's current session
      const enriched = sessions.map(s => ({
        ...s,
        isCurrent: s.id === currentSessionId
      }));

      res.json(enriched);
    } catch (err) {
      next(err);
    }
  });

  // ─── DELETE /api/sessions/:id ─────────────────────────────────────
  /**
   * Revoke a specific session belonging to the authenticated user.
   * Users can only revoke their own sessions (tenant + user scoped).
   * Returns: 204 No Content on success.
   */
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const sessionId = req.params['id'] as string;

      const session = await prisma.session.findFirst({
        where: {
          id: sessionId,
          userId,
          tenantId,
          deletedAt: { equals: null }
        }
      });

      if (!session) throw new ResourceNotFoundError();

      // Idempotent — already in a terminal state, treat as success
      const terminalStates: SessionStatus[] = [
        SessionStatus.REVOKED,
        SessionStatus.EXPIRED,
        SessionStatus.INVALIDATED
      ];
      if (!terminalStates.includes(session.status)) {
        await prisma.session.update({
          where: { id: sessionId },
          data: {
            status: SessionStatus.REVOKED,
            revokedAt: new Date()
          }
        });
      }

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
