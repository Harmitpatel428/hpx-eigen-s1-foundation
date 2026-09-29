import { Router, Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireCaseEngineEnabled } from '../middleware/case-engine.middleware';
import { AuthorizationError, ValidationError } from '../types/exceptions';
import { CaseTimelineService, UserContext } from '../services/case-timeline.service';

const T_VIEW = 'case-timeline:view';
const T_MANAGE = 'case-timeline:manage';

function ctxOf(req: Request): UserContext {
  const u = (req as AuthenticatedRequest).user;
  const ua = req.headers['user-agent'];
  return { tenantId: u.tenantId, userId: u.userId, actorIp: req.ip, actorUserAgent: Array.isArray(ua) ? ua[0] : ua };
}
function hasPerm(req: Request, slug: string): boolean {
  return !!(req as AuthenticatedRequest).user?.permissions?.[slug];
}

/** /api/v1/case-types/:caseTypeId/stages — stage template catalog. */
export function createCaseStageTemplatesRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });
  const svc = new CaseTimelineService(prisma);
  router.use(authMiddleware);
  router.use(requireCaseEngineEnabled(prisma));

  router.get('/', permissionMiddleware(T_VIEW), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.listTemplates(ctxOf(req), (req.params as any).caseTypeId, String(req.query.includeArchived) === 'true') }); } catch (e) { next(e); }
  });
  router.post('/', permissionMiddleware(T_MANAGE), async (req, res, next) => {
    try { res.status(201).json({ success: true, data: await svc.createTemplate(ctxOf(req), (req.params as any).caseTypeId, req.body) }); } catch (e) { next(e); }
  });
  router.put('/reorder', permissionMiddleware(T_MANAGE), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.reorderTemplates(ctxOf(req), (req.params as any).caseTypeId, (req.body?.orderedIds ?? []) as string[]) }); } catch (e) { next(e); }
  });
  router.patch('/:templateId', permissionMiddleware(T_MANAGE), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.updateTemplate(ctxOf(req), (req.params as any).caseTypeId, req.params.templateId, req.body) }); } catch (e) { next(e); }
  });
  router.post('/:templateId/archive', permissionMiddleware(T_MANAGE), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.archiveTemplate(ctxOf(req), (req.params as any).caseTypeId, req.params.templateId) }); } catch (e) { next(e); }
  });
  return router;
}

/** /api/v1/cases/:caseId/timeline — timeline instance read + create. */
export function createCaseTimelineRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });
  const svc = new CaseTimelineService(prisma);
  router.use(authMiddleware);
  router.use(requireCaseEngineEnabled(prisma));

  router.get('/', permissionMiddleware(T_VIEW), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.getTimeline(ctxOf(req), (req.params as any).caseId) }); } catch (e) { next(e); }
  });
  router.post('/', permissionMiddleware(T_MANAGE), async (req, res, next) => {
    try { res.status(201).json({ success: true, data: await svc.createTimeline(ctxOf(req), (req.params as any).caseId) }); } catch (e) { next(e); }
  });
  router.put('/target', permissionMiddleware(T_MANAGE), async (req, res, next) => {
    try {
      if (!req.body || !('targetDate' in req.body)) throw new ValidationError('targetDate is required (a YYYY-MM-DD string to set, or null to clear).');
      res.json({ success: true, data: await svc.setTarget(ctxOf(req), (req.params as any).caseId, req.body.targetDate) });
    } catch (e) { next(e); }
  });
  router.post('/recalc', permissionMiddleware(T_MANAGE), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.recalc(ctxOf(req), (req.params as any).caseId) }); } catch (e) { next(e); }
  });
  router.post('/approve-exception', permissionMiddleware('case-exception:approve'), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.approveException(ctxOf(req), (req.params as any).caseId, req.body?.reason) }); } catch (e) { next(e); }
  });
  return router;
}

/** /api/v1/cases/:caseId/stages — stage actions + events. */
export function createCaseStageActionsRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });
  const svc = new CaseTimelineService(prisma);
  router.use(authMiddleware);
  router.use(requireCaseEngineEnabled(prisma));
  const caseId = (req: Request) => (req.params as any).caseId as string;

  router.get('/:stageId/events', permissionMiddleware(T_VIEW), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.listStageEvents(ctxOf(req), caseId(req), req.params.stageId) }); } catch (e) { next(e); }
  });
  router.post('/:stageId/start', permissionMiddleware('case-stage:start'), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.startStage(ctxOf(req), caseId(req), req.params.stageId) }); } catch (e) { next(e); }
  });
  router.post('/:stageId/complete', permissionMiddleware('case-stage:complete'), async (req, res, next) => {
    try {
      const override = req.body?.override === true;
      if (override && !hasPerm(req, 'case-stage:override')) throw new AuthorizationError();
      res.json({ success: true, data: await svc.completeStage(ctxOf(req), caseId(req), req.params.stageId, { override, reason: req.body?.reason }) });
    } catch (e) { next(e); }
  });
  router.post('/:stageId/skip', permissionMiddleware('case-stage:skip'), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.skipStage(ctxOf(req), caseId(req), req.params.stageId, req.body?.reason) }); } catch (e) { next(e); }
  });
  router.post('/:stageId/reopen', permissionMiddleware('case-stage:reopen'), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.reopenStage(ctxOf(req), caseId(req), req.params.stageId) }); } catch (e) { next(e); }
  });
  router.post('/:stageId/pause', permissionMiddleware('case-stage:pause'), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.pauseStage(ctxOf(req), caseId(req), req.params.stageId) }); } catch (e) { next(e); }
  });
  router.post('/:stageId/resume', permissionMiddleware('case-stage:resume'), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.resumeStage(ctxOf(req), caseId(req), req.params.stageId) }); } catch (e) { next(e); }
  });
  router.post('/:stageId/override-duration', permissionMiddleware('case-stage:override'), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.overrideDuration(ctxOf(req), caseId(req), req.params.stageId, { remainingDuration: req.body?.remainingDuration, reason: req.body?.reason }) }); } catch (e) { next(e); }
  });
  return router;
}
