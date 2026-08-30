import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, HandoffReturnReason } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { HandoffService } from '../services/handoff.service';
import { PortalService } from '../services/portal.service';
import { ValidationError } from '../types/exceptions';

const RETURN_REASONS = Object.values(HandoffReturnReason);

function parseReason(value: unknown): HandoffReturnReason {
  if (typeof value !== 'string' || !RETURN_REASONS.includes(value as HandoffReturnReason))
    throw new ValidationError(`reasonCode must be one of: ${RETURN_REASONS.join(', ')}`);
  return value as HandoffReturnReason;
}

/** Mounted at /api/v1/cases — case-scoped handoff and portal-admin actions. */
export function createCasesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const handoff = new HandoffService(prisma);
  const portal = new PortalService(prisma);

  /** GET /api/v1/cases/incoming — Documentation handoff inbox */
  router.get('/incoming', authMiddleware, permissionMiddleware('handoff:accept'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        res.json({ success: true, data: await handoff.listIncoming({ tenantId, userId }) });
      } catch (err) { next(err); }
    });

  /** GET /api/v1/cases/search?caseNumber=HPX-XXXX-XXXX */
  router.get('/search', authMiddleware, permissionMiddleware('doc:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const caseNumber = req.query.caseNumber as string;
        if (!caseNumber) throw new ValidationError('caseNumber is required.');
        const found = await handoff.findByCaseNumber({ tenantId, userId }, caseNumber);
        res.json({ success: true, data: found ? [found] : [] });
      } catch (err) { next(err); }
    });

  /** POST /api/v1/cases/:caseId/handoff/accept */
  router.post('/:caseId/handoff/accept', authMiddleware, permissionMiddleware('handoff:accept'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        res.json({ success: true, data: await handoff.accept({ tenantId, userId }, req.params.caseId) });
      } catch (err) { next(err); }
    });

  /** POST /api/v1/cases/:caseId/handoff/reject — BEFORE acceptance only */
  router.post('/:caseId/handoff/reject', authMiddleware, permissionMiddleware('handoff:reject'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { reasonCode, note } = req.body as { reasonCode?: string; note?: string };
        const data = await handoff.reject(
          { tenantId, userId }, req.params.caseId, parseReason(reasonCode), note ?? '',
        );
        res.json({ success: true, data });
      } catch (err) { next(err); }
    });

  /** POST /api/v1/cases/:caseId/return — AFTER acceptance only */
  router.post('/:caseId/return', authMiddleware, permissionMiddleware('handoff:return'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { reasonCode, note } = req.body as { reasonCode?: string; note?: string };
        const data = await handoff.returnAfterAcceptance(
          { tenantId, userId }, req.params.caseId, parseReason(reasonCode), note ?? '',
        );
        res.json({ success: true, data });
      } catch (err) { next(err); }
    });

  /** POST /api/v1/cases/:caseId/handoff/resend — enforces Fix & Resend gating */
  router.post('/:caseId/handoff/resend', authMiddleware, permissionMiddleware('handoff:resend'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { resolutionNote } = req.body as { resolutionNote?: string };
        const data = await handoff.resend({ tenantId, userId }, req.params.caseId, resolutionNote ?? '');
        res.json({ success: true, data });
      } catch (err) { next(err); }
    });

  /** POST /api/v1/cases/:caseId/handoff/manager-review — clears the lock */
  router.post('/:caseId/handoff/manager-review', authMiddleware, permissionMiddleware('handoff:manager_review'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { note } = req.body as { note?: string };
        const data = await handoff.clearManagerReview({ tenantId, userId }, req.params.caseId, note ?? '');
        res.json({ success: true, data });
      } catch (err) { next(err); }
    });

  // ─── Portal administration (staff side) ────────────────────────────────────

  /** POST /api/v1/cases/:caseId/portal-contact/change-request */
  router.post('/:caseId/portal-contact/change-request', authMiddleware, permissionMiddleware('portal:contact_request'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { newPhone, reason } = req.body as { newPhone?: string; reason?: string };
        const data = await portal.requestContactChange(
          { tenantId, userId }, req.params.caseId, newPhone ?? '', reason ?? '',
        );
        res.status(201).json({ success: true, data });
      } catch (err) { next(err); }
    });

  /** POST /api/v1/cases/:caseId/portal-sessions/revoke */
  router.post('/:caseId/portal-sessions/revoke', authMiddleware, permissionMiddleware('portal:session_revoke'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        res.json({ success: true, data: await portal.revokeSessions({ tenantId, userId }, req.params.caseId) });
      } catch (err) { next(err); }
    });

  return router;
}

/** Mounted at /api/v1/leads/:leadId/handoff — the Sales-side entry point. */
export function createLeadHandoffRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });
  const handoff = new HandoffService(prisma);

  /** POST /api/v1/leads/:leadId/handoff/confirm */
  router.post('/confirm', authMiddleware, permissionMiddleware('handoff:submit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { presetId } = req.body as { presetId?: string };
        const leadId = (req.params as { leadId: string }).leadId;
        const data = await handoff.confirmHandoff({ tenantId, userId }, leadId, presetId);
        res.status(201).json({ success: true, data });
      } catch (err) { next(err); }
    });

  return router;
}

/** Mounted at /api/v1/portal-contact-change-requests — manager approval. */
export function createContactChangeRouter(prisma: PrismaClient): Router {
  const router = Router();
  const portal = new PortalService(prisma);

  router.post('/:requestId/approve', authMiddleware, permissionMiddleware('portal:contact_approve'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        res.json({ success: true, data: await portal.approveContactChange({ tenantId, userId }, req.params.requestId) });
      } catch (err) { next(err); }
    });

  router.post('/:requestId/reject', authMiddleware, permissionMiddleware('portal:contact_approve'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        res.json({ success: true, data: await portal.rejectContactChange({ tenantId, userId }, req.params.requestId) });
      } catch (err) { next(err); }
    });

  return router;
}
