import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, SessionStatus } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ResourceNotFoundError, AuthorizationError, BusinessRuleViolationError, ValidationError } from '../types/exceptions';
import { AuditService } from '../services/audit.service';

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function createSessionsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const auditService = new AuditService(prisma);

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

  // ─── POST /api/sessions/impersonate ──────────────────────────────
  /**
   * Admin impersonation — creates a short-lived session on behalf of another user.
   * Security invariants:
   *   - Requires user:impersonate permission (admin-only)
   *   - Tenant-scoped: target must be in same tenant
   *   - allowImpersonation toggle must be ON in TenantSettings (server-enforced)
   *   - Target must be ACTIVE
   *   - Cannot impersonate self
   *   - Impersonation session cannot itself impersonate (no chaining)
   *   - Actor identity preserved in impersonatedByUserId on the session
   */
  router.post(
    '/impersonate',
    permissionMiddleware('user:impersonate'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId: actorId, tenantId, impersonatedByUserId } = (req as AuthenticatedRequest).user;

        // Block impersonation chaining
        if (impersonatedByUserId) {
          throw new BusinessRuleViolationError('Cannot impersonate while already in an impersonation session.');
        }

        const { targetUserId } = req.body as { targetUserId?: string };
        if (!targetUserId) throw new ValidationError('targetUserId is required.');
        if (targetUserId === actorId) throw new BusinessRuleViolationError('Cannot impersonate yourself.');

        // Check the org-level toggle (server-enforced, not just frontend)
        const settings = await (prisma as any).tenantSettings.findUnique({ where: { tenantId } });
        if (!settings?.allowImpersonation) {
          throw new BusinessRuleViolationError('Admin impersonation is disabled for this organization.');
        }

        // Target must be active and in same tenant
        const target = await prisma.user.findFirst({
          where: { id: targetUserId, tenantId, deletedAt: { equals: null } },
          select: { id: true, status: true, firstName: true, lastName: true, email: true },
        });
        if (!target) throw new ResourceNotFoundError();
        if (target.status !== 'ACTIVE') {
          throw new BusinessRuleViolationError('Cannot impersonate an inactive user.');
        }

        // Create impersonation session
        const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
        const impersonationSession = await (prisma as any).session.create({
          data: {
            tenantId,
            userId: targetUserId,
            status: SessionStatus.ACTIVE,
            refreshTokenHash: 'impersonation-no-refresh',
            expiresAt,
            impersonatedByUserId: actorId,
          },
        });

        const secret = process.env.JWT_SECRET!;
        const accessToken = jwt.sign(
          { sessionId: impersonationSession.id, userId: targetUserId, tenantId },
          secret,
          { expiresIn: '1h' }
        );

        await auditService.log({
          tenantId,
          eventType: 'IMPERSONATION_STARTED',
          entityType: 'Session',
          entityId: impersonationSession.id,
          actorUserId: actorId,
          operation: 'CREATE',
          payload: {
            impersonatedUserId: targetUserId,
            impersonationSessionId: impersonationSession.id,
            startedAt: new Date().toISOString(),
          },
        });

        res.json({
          accessToken,
          impersonationSessionId: impersonationSession.id,
          impersonatedUser: {
            id: target.id,
            firstName: target.firstName,
            lastName: target.lastName,
            email: target.email,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── POST /api/sessions/exit-impersonation ────────────────────────
  /**
   * Exit impersonation — revokes the current impersonation session.
   * Must be called with the impersonation token (not the admin's original token).
   */
  router.post('/exit-impersonation', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId, impersonatedByUserId, tenantId, userId } = (req as AuthenticatedRequest).user;

      if (!impersonatedByUserId) {
        throw new BusinessRuleViolationError('Current session is not an impersonation session.');
      }

      await prisma.session.update({
        where: { id: sessionId },
        data: { status: SessionStatus.REVOKED, revokedAt: new Date() },
      });

      await auditService.log({
        tenantId,
        eventType: 'IMPERSONATION_ENDED',
        entityType: 'Session',
        entityId: sessionId,
        actorUserId: impersonatedByUserId, // original admin
        operation: 'UPDATE',
        payload: {
          impersonatedUserId: userId,
          impersonationSessionId: sessionId,
          endedAt: new Date().toISOString(),
        },
      });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
