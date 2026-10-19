import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, ProcessReturnReason } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ProcessHandoffService } from '../services/process-handoff.service';
import { ValidationError } from '../types/exceptions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mounted at /api/v1/process — the Process department queue + accept/return. */
export function createProcessRouter(prisma: PrismaClient): Router {
  const router = Router();
  const svc = new ProcessHandoffService(prisma);

  /** GET /api/v1/process/cases — Process incoming queue (PENDING_PROCESS_REVIEW). */
  router.get('/cases', authMiddleware, permissionMiddleware('process:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        res.json({ success: true, data: await svc.listPendingForProcess({ tenantId, userId }) });
      } catch (err) { next(err); }
    });

  /** POST /api/v1/process/cases/:id/accept — Process takes ownership. */
  router.post('/cases/:id/accept', authMiddleware, permissionMiddleware('process:accept'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        if (!UUID_RE.test(req.params.id)) throw new ValidationError('Invalid case id.');
        res.json({ success: true, data: await svc.accept({ tenantId, userId }, req.params.id) });
      } catch (err) { next(err); }
    });

  /** POST /api/v1/process/cases/:id/return — send back to Documentation (reason required). */
  router.post('/cases/:id/return', authMiddleware, permissionMiddleware('process:return'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        if (!UUID_RE.test(req.params.id)) throw new ValidationError('Invalid case id.');
        const { reasonCode, note } = req.body as { reasonCode?: string; note?: string };
        // The service validates reason-required + note-iff-OTHER via checkReturnReason.
        const data = await svc.returnToDocumentation(
          { tenantId, userId }, req.params.id, reasonCode as ProcessReturnReason, note ?? '',
        );
        res.json({ success: true, data });
      } catch (err) { next(err); }
    });

  return router;
}
