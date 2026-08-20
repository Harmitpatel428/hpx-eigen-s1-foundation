import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { LeadActivitiesService, GlobalFilter } from '../services/lead-activities.service';
import { ValidationError } from '../types/exceptions';

const VALID_FILTERS: GlobalFilter[] = ['ALL', 'DUE_TODAY', 'UPCOMING', 'OVERDUE', 'MINE'];

export function createGlobalLeadActivitiesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = new LeadActivitiesService(prisma);

  // GET /api/v1/lead-activities?filter=DUE_TODAY&page=1&pageSize=50
  router.get(
    '/',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const filter = (req.query.filter as GlobalFilter) ?? 'ALL';
        if (!VALID_FILTERS.includes(filter)) throw new ValidationError('Invalid filter value.');
        const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
        const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 50;
        if (page < 1 || isNaN(page)) throw new ValidationError('page must be a positive integer.');
        if (pageSize < 1 || pageSize > 200 || isNaN(pageSize)) throw new ValidationError('pageSize must be between 1 and 200.');
        const result = await service.listGlobal({ tenantId, userId }, filter, page, pageSize);
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  // POST /api/v1/lead-activities — schedule a meeting or other activity
  router.post(
    '/',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const { leadId, type, subject, scheduledAt, metadata } = req.body as {
          leadId: string;
          type: string;
          subject: string;
          scheduledAt?: string;
          metadata?: Record<string, unknown>;
        };
        if (!leadId) throw new ValidationError('leadId is required.');
        if (!type) throw new ValidationError('type is required.');
        if (!subject || !subject.trim()) throw new ValidationError('subject is required.');
        const activity = await service.createActivity(
          { tenantId, userId },
          { leadId, type, subject: subject.trim(), scheduledAt, metadata }
        );
        res.status(201).json({ data: activity });
      } catch (err) {
        next(err);
      }
    }
  );

  // PATCH /api/v1/lead-activities/:id/complete
  router.patch(
    '/:id/complete',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const activity = await service.markComplete({ tenantId, userId }, req.params.id);
        res.json({ data: activity });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
