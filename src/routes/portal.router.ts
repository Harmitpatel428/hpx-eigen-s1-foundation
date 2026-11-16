import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { PortalService, PortalVerificationFailed } from '../services/portal.service';
import { PORTAL_VERIFICATION_FAILED, PORTAL_HTTP_STATUS } from '../domain/portal';
import { logger } from '../utils/logger';
import { ValidationError } from '../types/exceptions';

/**
 * PUBLIC router — no authMiddleware on the client-facing routes.
 *
 * Every verification FAILURE returns the identical 401 status and body, and the
 * internal reason is written to the server log only. Do not add a distinguishing
 * status code, a different message, or a "remaining attempts" counter for the
 * failure path: each turns the endpoint into an oracle for valid case numbers.
 *
 * The ONE exception is lockout (429): it is keyed on (caseNumber, ip) and fires
 * regardless of whether the case exists, so a 429 only reaches an ip that already
 * made the failed attempts — it reveals nothing a prober didn't already cause,
 * and it stops a legitimate caller with the CORRECT details from being told
 * "wrong details" while they are merely rate-limited.
 */
export function createPortalRouter(prisma: PrismaClient): Router {
  const router = Router();
  const portal = new PortalService(prisma);

  const fail = (res: Response, err: PortalVerificationFailed, path: string) => {
    logger.warn({ internalReason: err.internalReason, path }, 'Portal verification failed');
    if (err.locked) {
      res.status(429).json({ error: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Please wait and try again later.' });
      return;
    }
    res.status(PORTAL_HTTP_STATUS).json(PORTAL_VERIFICATION_FAILED);
  };

  // req.ip honours Express 'trust proxy' (app.ts, TRUST_PROXY_HOPS); never read x-forwarded-for directly —
  // a client-supplied header would let an attacker rotate the lockout key.
  const clientIp = (req: Request): string => req.ip || 'unknown';

  /** POST /api/v1/portal/verify — Case number + last 4 phone digits. No OTP. */
  router.post('/verify', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { caseNumber, phoneLast4 } = (req.body ?? {}) as { caseNumber?: unknown; phoneLast4?: unknown };
      if (typeof caseNumber !== 'string' || !caseNumber.trim()) {
        throw new ValidationError('caseNumber is required.');
      }
      if (typeof phoneLast4 !== 'string' || !/^\d{4}$/.test(phoneLast4)) {
        throw new ValidationError('phoneLast4 must be exactly 4 digits.');
      }
      const result = await portal.verify(
        caseNumber, phoneLast4, clientIp(req), req.headers['user-agent'],
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
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        // The preview URL carries a CASE NUMBER (HPX-XXXX-XXXX), not the internal UUID — resolve by caseNumber,
        // tenant-scoped (permission alone does not authorise reading another tenant's case). Resolving by `id`
        // would throw P2023 on the non-UUID input and surface as a generic 500.
        const owned = await prisma.docCase.findFirst({
          where: { caseNumber: req.params.caseId, tenantId, deletedAt: null },
          select: { id: true },
        });
        if (!owned) { res.status(404).json({ code: 'RESOURCE_NOT_FOUND', message: 'Case not found.' }); return; }

        // Audit the staff preview access (read-only; no client session is ever minted here).
        await portal.recordPreviewAccess({ tenantId, userId }, owned.id);
        // preview: render content even if the client portal is not yet activated; payload carries portalActive.
        res.json({ success: true, data: { ...await portal.getCaseView(owned.id, { preview: true }), isPreview: true } });
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
