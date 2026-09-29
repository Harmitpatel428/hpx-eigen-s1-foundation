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

function wantsArchived(req: Request): boolean {
  return String(req.query.includeArchived) === 'true';
}

export function createCaseFieldsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = new CaseFieldService(prisma);

  // Gate order: auth -> tenant context (from auth) -> feature flag -> permission (per route).
  router.use(authMiddleware);
  router.use(requireCaseEngineEnabled(prisma));

  // ─── Definitions ───────────────────────────────────────────────
  router.get('/', permissionMiddleware(VIEW), async (req, res, next) => {
    try {
      const data = await service.listFields(ctxOf(req), wantsArchived(req));
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.post('/', permissionMiddleware(MANAGE), async (req, res, next) => {
    try {
      const data = await service.createField(ctxOf(req), req.body);
      res.status(201).json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.get('/:id', permissionMiddleware(VIEW), async (req, res, next) => {
    try {
      const data = await service.getField(ctxOf(req), req.params.id);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.patch('/:id', permissionMiddleware(MANAGE), async (req, res, next) => {
    try {
      const data = await service.updateField(ctxOf(req), req.params.id, req.body);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.post('/:id/activate', permissionMiddleware(MANAGE), async (req, res, next) => {
    try {
      const data = await service.activateField(ctxOf(req), req.params.id);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.post('/:id/read-only', permissionMiddleware(MANAGE), async (req, res, next) => {
    try {
      const data = await service.setFieldReadOnly(ctxOf(req), req.params.id);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.post('/:id/archive', permissionMiddleware(MANAGE), async (req, res, next) => {
    try {
      const data = await service.archiveField(ctxOf(req), req.params.id);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.delete('/:id', permissionMiddleware(MANAGE), async (req, res, next) => {
    try {
      await service.hardDeleteField(ctxOf(req), req.params.id);
      res.json({ success: true, data: { id: req.params.id } });
    } catch (err) { next(err); }
  });

  // ─── Options (nested under a field) ────────────────────────────
  router.get('/:fieldId/options', permissionMiddleware(VIEW), async (req, res, next) => {
    try {
      const data = await service.listOptions(ctxOf(req), req.params.fieldId, wantsArchived(req));
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.post('/:fieldId/options', permissionMiddleware(MANAGE), async (req, res, next) => {
    try {
      const data = await service.createOption(ctxOf(req), req.params.fieldId, req.body);
      res.status(201).json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.patch('/:fieldId/options/:optionId', permissionMiddleware(MANAGE), async (req, res, next) => {
    try {
      const data = await service.updateOption(ctxOf(req), req.params.fieldId, req.params.optionId, req.body);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  router.post('/:fieldId/options/:optionId/archive', permissionMiddleware(MANAGE), async (req, res, next) => {
    try {
      const data = await service.archiveOption(ctxOf(req), req.params.fieldId, req.params.optionId);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });

  return router;
}
