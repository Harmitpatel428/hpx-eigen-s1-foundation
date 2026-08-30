import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { PortalService, PortalVerificationFailed } from '../services/portal.service';
import { PORTAL_VERIFICATION_FAILED, PORTAL_HTTP_STATUS } from '../domain/portal';
import { logger } from '../utils/logger';

/**
 * PUBLIC router — no authMiddleware on the client-facing routes.
 *
 * Every failure returns the identical status and body. The internal reason is
 * written to the server log only. Do not add a distinguishing status code, a
 * different message, or a "remaining attempts" counter here: each of those
 * turns the endpoint into an oracle for valid case numbers.
 */
export function createPortalRouter(prisma: PrismaClient): Router {
  const router = Router();
  const portal = new PortalService(prisma);

  const fail = (res: Response, err: PortalVerificationFailed, path: string) => {
    logger.warn({ internalReason: err.internalReason, path }, 'Portal verification failed');
    res.status(PORTAL_HTTP_STATUS).json(PORTAL_VERIFICATION_FAILED);
  };

  const clientIp = (req: Request): string =>
    (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || 'unknown';

  /** POST /api/v1/portal/verify — Case number + last 4 phone digits. No OTP. */
  router.post('/verify', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { caseNumber, phoneLast4 } = req.body as { caseNumber?: string; phoneLast4?: string };
      const result = await portal.verify(
        caseNumber ?? '', phoneLast4 ?? '', clientIp(req), req.headers['user-agent'],
      );
      res.json({ success: true, data: result });
    } catch (err) {
      if (err instanceof PortalVerificationFailed) return fail(res, err, '/verify');
      next(err);
    }
  });

  /** GET /api/v1/portal/case — requires a live portal session token. */
  router.get('/case', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : '';
      const session = await portal.resolveSession(token);
      res.json({ success: true, data: await portal.getCaseView(session.caseId) });
    } catch (err) {
      if (err instanceof PortalVerificationFailed) return fail(res, err, '/case');
      next(err);
    }
  });

  /** POST /api/v1/portal/sign-out — always 204, even for an unknown token. */
  router.post('/sign-out', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : '';
      if (token) await portal.signOut(token);
      res.status(204).send();
    } catch (err) { next(err); }
  });

  // ─── Staff-only, authenticated ─────────────────────────────────────────────

  /** GET /api/v1/portal/preview/:caseId — internal staff preview. */
  router.get('/preview/:caseId', authMiddleware, permissionMiddleware('portal:preview'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        // Tenant-scope the lookup before rendering — permission alone does not
        // authorise reading another tenant's case.
        const owned = await prisma.docCase.findFirst({
          where: { id: req.params.caseId, tenantId, deletedAt: null },
          select: { id: true },
        });
        if (!owned) { res.status(404).json({ code: 'RESOURCE_NOT_FOUND', message: 'Case not found.' }); return; }

        res.json({ success: true, data: { ...await portal.getCaseView(owned.id), isPreview: true } });
      } catch (err) {
        if (err instanceof PortalVerificationFailed) {
          res.status(409).json({
            code: 'PORTAL_NOT_ACTIVE',
            message: 'This case has no client-visible content yet, so its portal is not active.',
          });
          return;
        }
        next(err);
      }
    });

  /** GET /api/v1/portal/session-stats — powers the settings panel. */
  router.get('/session-stats', authMiddleware, permissionMiddleware('portal:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        res.json({ success: true, data: await portal.activeSessionStats({ tenantId, userId }) });
      } catch (err) { next(err); }
    });

  return router;
}

/** Mounted at /api/v1/publishing — client-visibility toggles. */
export function createPublishingRouter(prisma: PrismaClient): Router {
  const router = Router();
  const portal = new PortalService(prisma);

  /** PATCH /api/v1/publishing/notes/:noteId/visibility */
  router.patch('/notes/:noteId/visibility', authMiddleware, permissionMiddleware('portal:publish'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { clientVisible } = req.body as { clientVisible?: boolean };
        const data = await portal.setNoteVisibility({ tenantId, userId }, req.params.noteId, clientVisible === true);
        res.json({ success: true, data });
      } catch (err) { next(err); }
    });

  /** PATCH /api/v1/publishing/documents/:documentId/visibility */
  router.patch('/documents/:documentId/visibility', authMiddleware, permissionMiddleware('portal:publish'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { clientVisible } = req.body as { clientVisible?: boolean };
        const data = await portal.setDocumentVisibility({ tenantId, userId }, req.params.documentId, clientVisible === true);
        res.json({ success: true, data });
      } catch (err) { next(err); }
    });

  return router;
}
