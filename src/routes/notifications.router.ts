import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { NotificationService } from '../services/notification.service';

export function createNotificationsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const notificationService = new NotificationService(prisma);

  router.use(authMiddleware);

  // GET /api/v1/notifications
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const cursor = req.query.cursor as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      const result = await notificationService.list(tenantId, userId, { cursor, limit });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/notifications/unread-count
  router.get('/unread-count', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const count = await notificationService.unreadCount(tenantId, userId);
      res.json({ success: true, data: { count } });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/v1/notifications/:id/read
  router.patch('/:id/read', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      await notificationService.markRead(tenantId, userId, req.params.id!);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/v1/notifications/read-all
  router.patch('/read-all', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      await notificationService.markAllRead(tenantId, userId);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
