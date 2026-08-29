import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { LeadActivitiesService, GlobalFilter } from '../services/lead-activities.service';
import { ValidationError } from '../types/exceptions';
import { buildOwnerFilter, type ScopeType } from '../utils/scope.helper';

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
        const { userId, tenantId, scope, teamId, departmentId } = (req as AuthenticatedRequest).user;
        const filter = (req.query.filter as GlobalFilter) ?? 'ALL';
        if (!VALID_FILTERS.includes(filter)) throw new ValidationError('Invalid filter value.');
        const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
        const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 50;
        if (page < 1 || isNaN(page)) throw new ValidationError('page must be a positive integer.');
        if (pageSize < 1 || pageSize > 200 || isNaN(pageSize)) throw new ValidationError('pageSize must be between 1 and 200.');
        const result = await service.listGlobal(
          { tenantId, userId }, filter, page, pageSize,
          { scope: (scope ?? 'OWN') as ScopeType, teamId: teamId ?? null, departmentId: departmentId ?? null },
        );
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
        const { userId, tenantId, scope, teamId, departmentId } = (req as AuthenticatedRequest).user;
        // Verify the user's scope grants access to this activity's lead
        const ownerFilter = await buildOwnerFilter(
          (scope ?? 'OWN') as ScopeType, userId, teamId ?? null, departmentId ?? null, prisma, true
        );
        const activity = await (prisma as any).leadActivity.findFirst({
          where: { id: req.params.id, tenantId, deletedAt: null },
          select: { leadId: true },
        });
        if (activity) {
          const lead = await prisma.lead.findFirst({
            where: { id: activity.leadId, tenantId, deletedAt: null, ...ownerFilter },
            select: { id: true },
          });
          if (!lead) { res.status(404).json({ error: { message: 'Activity not found.' } }); return; }
        }
        const { note, nextFollowUp } = req.body as { note?: string; nextFollowUp?: string };
        const completed = await service.markComplete({ tenantId, userId }, req.params.id, { note, nextFollowUp });
        res.json({ data: completed });
      } catch (err) {
        next(err);
      }
    }
  );

  // POST /api/v1/lead-activities/bulk-complete
  router.post(
    '/bulk-complete',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId, scope, teamId, departmentId } = (req as AuthenticatedRequest).user;
        const { ids } = req.body as { ids: string[] };
        if (!Array.isArray(ids) || ids.length === 0) throw new ValidationError('ids must be a non-empty array.');
        // Scope-filter: only complete activities whose lead the user can access
        const ownerFilter = await buildOwnerFilter(
          (scope ?? 'OWN') as ScopeType, userId, teamId ?? null, departmentId ?? null, prisma, true
        );
        const accessible = await (prisma as any).leadActivity.findMany({
          where: { id: { in: ids }, tenantId, deletedAt: null, lead: { deletedAt: null, ...ownerFilter } },
          select: { id: true },
        });
        const accessibleIds = accessible.map((a: any) => a.id as string);
        if (accessibleIds.length === 0) { res.json({ count: 0 }); return; }
        const result = await service.bulkComplete({ tenantId, userId }, accessibleIds);
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
