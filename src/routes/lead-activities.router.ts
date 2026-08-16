import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { LeadActivitiesService } from '../services/lead-activities.service';
import { ValidationError } from '../types/exceptions';

export function createLeadActivitiesRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });
  const service = new LeadActivitiesService(prisma);

  // ─── GET /api/v1/leads/:leadId/activities ─────────────────────────
  router.get(
    '/',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const { leadId } = req.params;
        const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
        const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 50;
        if (page < 1 || isNaN(page)) throw new ValidationError('page must be a positive integer.');
        if (pageSize < 1 || pageSize > 200 || isNaN(pageSize)) throw new ValidationError('pageSize must be between 1 and 200.');
        const result = await service.listByLead({ tenantId, userId }, leadId, page, pageSize);
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
