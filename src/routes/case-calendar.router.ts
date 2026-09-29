import { Router, Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { requireCaseEngineEnabled } from '../middleware/case-engine.middleware';
import { CaseCalendarService, UserContext } from '../services/case-calendar.service';

const VIEW = 'case-timeline:view';
const MANAGE = 'case-calendar:manage';

function ctxOf(req: Request): UserContext {
  const u = (req as AuthenticatedRequest).user;
  const ua = req.headers['user-agent'];
  return { tenantId: u.tenantId, userId: u.userId, actorIp: req.ip, actorUserAgent: Array.isArray(ua) ? ua[0] : ua };
}

/** /api/v1/case-calendar — firm working calendar + holidays. */
export function createCaseCalendarRouter(prisma: PrismaClient): Router {
  const router = Router();
  const svc = new CaseCalendarService(prisma);
  router.use(authMiddleware);
  router.use(requireCaseEngineEnabled(prisma));

  router.get('/', permissionMiddleware(VIEW), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.getCalendar(ctxOf(req)) }); } catch (e) { next(e); }
  });
  router.put('/', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.upsertCalendar(ctxOf(req), req.body ?? {}) }); } catch (e) { next(e); }
  });
  router.post('/holidays', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.status(201).json({ success: true, data: await svc.addHoliday(ctxOf(req), req.body ?? {}) }); } catch (e) { next(e); }
  });
  router.delete('/holidays/:holidayId', permissionMiddleware(MANAGE), async (req, res, next) => {
    try { res.json({ success: true, data: await svc.removeHoliday(ctxOf(req), req.params.holidayId) }); } catch (e) { next(e); }
  });
  return router;
}
