import { Router, Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireCaseEngineEnabled } from '../middleware/case-engine.middleware';
import { CaseTypeService, UserContext } from '../services/case-type.service';

const VIEW = 'case-type:view';
const MANAGE = 'case-type:manage';
const PUBLISH = 'case-type:publish';

function ctxOf(req: Request): UserContext {
  const u = (req as AuthenticatedRequest).user;
  const ua = req.headers['user-agent'];
  return { tenantId: u.tenantId, userId: u.userId, actorIp: req.ip, actorUserAgent: Array.isArray(ua) ? ua[0] : ua };
}
const wantsArchived = (req: Request) => String(req.query.includeArchived) === 'true';

export function createCaseTypesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = new CaseTypeService(prisma);

  router.use(authMiddleware);
  router.use(requireCaseEngineEnabled(prisma));

  // ─── Catalog ───────────────────────────────────────────────────
  router.get('/', permissionMiddleware(VIEW), async (req, res, next) => {
    try { res.json({ success: true, data: await service.listTypes(ctxOf(req), wantsArchived(req)) }); } catch (e) { next(e); }
  });
  router.post('/', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.status(201).json({ success: true, data: await service.createType(ctxOf(req), req.body) }); } catch (e) { next(e); }
  });
  router.get('/:caseTypeId', permissionMiddleware(VIEW), async (req, res, next) => {
    try { res.json({ success: true, data: await service.getType(ctxOf(req), req.params.caseTypeId) }); } catch (e) { next(e); }
  });
  router.patch('/:caseTypeId', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.json({ success: true, data: await service.updateType(ctxOf(req), req.params.caseTypeId, req.body) }); } catch (e) { next(e); }
  });
  router.post('/:caseTypeId/publish', permissionMiddleware(PUBLISH), async (req, res, next) => {
    try { res.json({ success: true, data: await service.publishType(ctxOf(req), req.params.caseTypeId) }); } catch (e) { next(e); }
  });
  router.post('/:caseTypeId/archive', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.json({ success: true, data: await service.archiveType(ctxOf(req), req.params.caseTypeId) }); } catch (e) { next(e); }
  });

  // ─── Placements ────────────────────────────────────────────────
  router.get('/:caseTypeId/fields', permissionMiddleware(VIEW), async (req, res, next) => {
    try { res.json({ success: true, data: await service.listPlacements(ctxOf(req), req.params.caseTypeId) }); } catch (e) { next(e); }
  });
  router.post('/:caseTypeId/fields', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.status(201).json({ success: true, data: await service.addPlacement(ctxOf(req), req.params.caseTypeId, req.body) }); } catch (e) { next(e); }
  });
  router.patch('/:caseTypeId/fields/:fieldId', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.json({ success: true, data: await service.updatePlacement(ctxOf(req), req.params.caseTypeId, req.params.fieldId, req.body) }); } catch (e) { next(e); }
  });
  router.delete('/:caseTypeId/fields/:fieldId', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { await service.removePlacement(ctxOf(req), req.params.caseTypeId, req.params.fieldId); res.json({ success: true, data: { caseTypeId: req.params.caseTypeId, fieldId: req.params.fieldId } }); } catch (e) { next(e); }
  });

  return router;
}

/** PATCH /api/v1/cases/:caseId/case-type — assign/clear a case's type (doc:edit). */
export function createCaseTypeAssignmentRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });
  const service = new CaseTypeService(prisma);

  router.use(authMiddleware);
  router.use(requireCaseEngineEnabled(prisma));

  router.patch('/', permissionMiddleware('doc:edit'), async (req, res, next) => {
    try {
      const { caseTypeId } = req.body as { caseTypeId?: string | null };
      const data = await service.assignCaseType(ctxOf(req), (req.params as any).caseId, caseTypeId ?? null);
      res.json({ success: true, data });
    } catch (e) { next(e); }
  });

  return router;
}
