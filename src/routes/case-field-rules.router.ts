import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireCaseEngineEnabled } from '../middleware/case-engine.middleware';
import { CaseFieldService, UserContext } from '../services/case-field.service';

const VIEW = 'case-field:view';
const MANAGE = 'case-field:manage';

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

export function createCaseFieldRulesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = new CaseFieldService(prisma);

  router.use(authMiddleware);
  router.use(requireCaseEngineEnabled(prisma));

  router.get('/', permissionMiddleware(VIEW), async (req, res, next) => {
    try {
      const data = await service.listRules(ctxOf(req), String(req.query.includeArchived) === 'true');
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.post('/', permissionMiddleware(MANAGE), async (req, res, next) => {
    try {
      const data = await service.createRule(ctxOf(req), req.body);
      res.status(201).json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.get('/:id', permissionMiddleware(VIEW), async (req, res, next) => {
    try {
      const data = await service.getRule(ctxOf(req), req.params.id);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.patch('/:id', permissionMiddleware(MANAGE), async (req, res, next) => {
    try {
      const data = await service.updateRule(ctxOf(req), req.params.id, req.body);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.post('/:id/archive', permissionMiddleware(MANAGE), async (req, res, next) => {
    try {
      const data = await service.archiveRule(ctxOf(req), req.params.id);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  return router;
}
