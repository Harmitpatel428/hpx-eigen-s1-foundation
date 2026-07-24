import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, OpportunityStage, OpportunityCurrency, Prisma } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { OpportunityService } from '../services/opportunity.service';
import { ValidationError } from '../types/exceptions';
import { buildOwnerFilter, ScopeType } from '../utils/scope.helper';

export function createOpportunitiesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const opportunityService = new OpportunityService(prisma);

  // ─── POST /api/v1/opportunities ───────────────────────────────────
  /** Create a new opportunity — requires opportunity:create */
  router.post(
    '/',
    authMiddleware,
    permissionMiddleware('opportunity:create'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const {
          leadId,
          contactId,
          ownerId,
          title,
          value,
          currency,
          opportunityTypeId,
          customOpportunityType,
          expectedCloseDate,
        } = req.body as {
          leadId: string;
          contactId?: string;
          ownerId?: string;
          title: string;
          value: number | string;
          currency?: OpportunityCurrency;
          opportunityTypeId?: string;
          customOpportunityType?: string;
          expectedCloseDate?: string;
        };

        if (!leadId || !title || value === undefined) {
          throw new ValidationError('leadId, title, and value are required.');
        }

        const opportunity = await opportunityService.createOpportunity(
          { tenantId, userId },
          {
            leadId,
            contactId,
            ownerId: ownerId ?? userId,
            title,
            value,
            currency,
            opportunityTypeId,
            customOpportunityType,
            expectedCloseDate: expectedCloseDate ? new Date(expectedCloseDate) : undefined,
          }
        );

        res.status(201).json(opportunity);
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /api/v1/opportunities ────────────────────────────────────
  /**
   * List opportunities with dynamic ABAC scope filtering.
   * Scope is injected by permissionMiddleware from the permission manifest.
   */
  router.get(
    '/',
    authMiddleware,
    permissionMiddleware('opportunity:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          userId,
          tenantId,
          teamId,
          departmentId,
          scope,
        } = (req as AuthenticatedRequest).user;

        const stage = req.query.stage as OpportunityStage | undefined;
        const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
        const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 50;

        if (stage && !Object.values(OpportunityStage).includes(stage)) {
          throw new ValidationError(
            `stage must be one of: ${Object.values(OpportunityStage).join(', ')}`
          );
        }

        const ownerFilter = await buildOwnerFilter(
          (scope ?? 'OWN') as ScopeType,
          userId,
          teamId,
          departmentId,
          prisma
        );

        const whereClause: Prisma.OpportunityWhereInput = {
          tenantId,
          deletedAt: null,
          ...ownerFilter,
        };

        if (stage) whereClause.stage = stage;

        const skip = (page - 1) * pageSize;
        const [data, total] = await Promise.all([
          prisma.opportunity.findMany({
            where: whereClause,
            skip,
            take: pageSize,
            orderBy: { createdAt: 'desc' },
            include: {
              lead: { select: { id: true, firstName: true, lastName: true, company: true } },
              contact: { select: { id: true, firstName: true, lastName: true } },
            },
          }),
          prisma.opportunity.count({ where: whereClause }),
        ]);

        res.json({ data, total, page, pageSize });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /api/v1/opportunities/:id ────────────────────────────────
  /** Get a single opportunity — requires opportunity:view */
  router.get(
    '/:id',
    authMiddleware,
    permissionMiddleware('opportunity:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const opportunity = await opportunityService.getOpportunityById(
          { tenantId, userId },
          req.params.id
        );
        res.json(opportunity);
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── PUT /api/v1/opportunities/:id ────────────────────────────────
  /** Update opportunity metadata — requires opportunity:edit */
  router.put(
    '/:id',
    authMiddleware,
    permissionMiddleware('opportunity:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const {
          contactId,
          ownerId,
          title,
          value,
          currency,
          opportunityTypeId,
          customOpportunityType,
          expectedCloseDate,
        } = req.body as {
          contactId?: string;
          ownerId?: string;
          title?: string;
          value?: number | string;
          currency?: OpportunityCurrency;
          opportunityTypeId?: string;
          customOpportunityType?: string;
          expectedCloseDate?: string;
        };

        const opportunity = await opportunityService.updateOpportunity(
          { tenantId, userId },
          req.params.id,
          {
            contactId,
            ownerId,
            title,
            value,
            currency,
            opportunityTypeId,
            customOpportunityType,
            expectedCloseDate: expectedCloseDate ? new Date(expectedCloseDate) : undefined,
          }
        );

        res.json(opportunity);
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── PUT /api/v1/opportunities/:id/stage ─────────────────────────
  /** Advance opportunity stage — requires opportunity:edit */
  router.put(
    '/:id/stage',
    authMiddleware,
    permissionMiddleware('opportunity:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const { stage, lostReason } = req.body as {
          stage: OpportunityStage;
          lostReason?: string;
        };

        if (!stage) throw new ValidationError('stage is required.');

        const opportunity = await opportunityService.advanceStage(
          { tenantId, userId },
          req.params.id,
          stage,
          lostReason
        );

        res.json(opportunity);
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── POST /api/v1/opportunities/:id/close ────────────────────────
  /** Close an opportunity — requires opportunity:edit */
  router.post(
    '/:id/close',
    authMiddleware,
    permissionMiddleware('opportunity:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const { outcome, lostReason } = req.body as {
          outcome: 'WON' | 'LOST';
          lostReason?: string;
        };

        if (!outcome || !['WON', 'LOST'].includes(outcome)) {
          throw new ValidationError('outcome must be WON or LOST.');
        }

        const opportunity = await opportunityService.closeOpportunity(
          { tenantId, userId },
          req.params.id,
          { outcome, lostReason }
        );

        res.json(opportunity);
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── DELETE /api/v1/opportunities/:id ────────────────────────────
  /** Soft-delete an opportunity — requires opportunity:delete */
  router.delete(
    '/:id',
    authMiddleware,
    permissionMiddleware('opportunity:delete'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        await opportunityService.deleteOpportunity({ tenantId, userId }, req.params.id);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
