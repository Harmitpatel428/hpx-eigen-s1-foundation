import { Router, Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireCaseEngineEnabled } from '../middleware/case-engine.middleware';
import { CaseFieldValueService, UserContext } from '../services/case-field-value.service';

const VIEW = 'doc:view';
const EDIT = 'doc:edit';

function ctxOf(req: Request): UserContext {
  const u = (req as AuthenticatedRequest).user;
  const ua = req.headers['user-agent'];
  return {
    tenantId: u.tenantId,
    userId: u.userId,
    actorIp: req.ip,
    actorUserAgent: Array.isArray(ua) ? ua[0] : ua,
  };
}

/** Mounted at /api/v1/cases/:caseId/field-values (mergeParams for caseId). */
export function createCaseFieldValuesRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });
  const service = new CaseFieldValueService(prisma);

  // Gate order: auth -> tenant context (from auth) -> feature flag -> permission.
  router.use(authMiddleware);
  router.use(requireCaseEngineEnabled(prisma));

  router.get('/', permissionMiddleware(VIEW), async (req, res, next) => {
    try {
      const data = await service.getValues(ctxOf(req), req.params.caseId);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.patch('/', permissionMiddleware(EDIT), async (req, res, next) => {
    try {
      const body = req.body as { values?: unknown };
      const data = await service.patchValues(ctxOf(req), req.params.caseId, (body.values ?? []) as any);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.post('/validate', permissionMiddleware(VIEW), async (req, res, next) => {
    try {
      const data = await service.validateValues(ctxOf(req), req.params.caseId);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.get('/history', permissionMiddleware(VIEW), async (req, res, next) => {
    try {
      const data = await service.getHistory(ctxOf(req), req.params.caseId);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  return router;
}
