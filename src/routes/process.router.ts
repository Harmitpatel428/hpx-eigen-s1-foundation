import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, ProcessReturnReason, DocCaseStatus } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ProcessHandoffService } from '../services/process-handoff.service';
import { ValidationError } from '../types/exceptions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True iff the caller may see the full Process queue (else restricted to self). */
function canViewAll(req: Request): boolean {
  return !!(req as AuthenticatedRequest).user.permissions['process:case:view-all'];
}
/** processAssignedTo-self restriction for non-view-all callers (undefined = full queue). */
function restrictTo(req: Request): string | undefined {
  return canViewAll(req) ? undefined : (req as AuthenticatedRequest).user.userId;
}

/** Mounted at /api/v1/process — the Process department queue + accept/return. */
export function createProcessRouter(prisma: PrismaClient): Router {
  const router = Router();
  const svc = new ProcessHandoffService(prisma);

  /**
   * GET /api/v1/process/cases — Process case queue (the three Process statuses).
   * Query: status?, search?, page?, pageSize? (default 50). View-all/self scoped.
   */
  router.get('/cases', authMiddleware, permissionMiddleware('process:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const q = req.query as Record<string, string | undefined>;
        if (q.status && !(q.status in DocCaseStatus)) throw new ValidationError('Invalid status filter.');
        const toInt = (v: string | undefined) => (v !== undefined ? Number.parseInt(v, 10) : undefined);
        const data = await svc.listCasesForProcess(
          { tenantId, userId },
          {
            status: q.status as DocCaseStatus | undefined,
            search: q.search?.trim() || undefined,
            page: toInt(q.page),
            pageSize: toInt(q.pageSize),
            restrictToUserId: restrictTo(req),
          },
        );
        res.json({ success: true, data });
      } catch (err) { next(err); }
    });

  /** GET /api/v1/process/cases/:id — Process case detail (view-all/self scoped; 404 if out of scope). */
  router.get('/cases/:id', authMiddleware, permissionMiddleware('process:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        if (!UUID_RE.test(req.params.id)) throw new ValidationError('Invalid case id.');
        const data = await svc.getCaseForProcess({ tenantId, userId }, req.params.id, { restrictToUserId: restrictTo(req) });
        res.json({ success: true, data });
      } catch (err) { next(err); }
    });

  /** POST /api/v1/process/cases/:id/assign — assign a Process case to a Process Executive. */
  router.post('/cases/:id/assign', authMiddleware, permissionMiddleware('process:assign'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        if (!UUID_RE.test(req.params.id)) throw new ValidationError('Invalid case id.');
        const { assigneeUserId } = req.body as { assigneeUserId?: string };
        if (!assigneeUserId || !UUID_RE.test(assigneeUserId)) throw new ValidationError('assigneeUserId must be a valid uuid.');
        res.json({ success: true, data: await svc.assign({ tenantId, userId }, req.params.id, assigneeUserId) });
      } catch (err) { next(err); }
    });

  /** GET /api/v1/process/dashboard — Process KPI counts (view-all/self scoped). */
  router.get('/dashboard', authMiddleware, permissionMiddleware('process:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        res.json({ success: true, data: await svc.dashboard({ tenantId, userId }, { restrictToUserId: restrictTo(req) }) });
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
