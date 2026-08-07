import { Router, Request, Response, NextFunction } from 'express';
import {
  PrismaClient,
  LeadStatus,
  LeadSource,
  LeadStage,
  LeadPriority,
  OpportunityCurrency,
  Prisma,
} from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { LeadService } from '../services/lead.service';
import { ValidationError } from '../types/exceptions';
import { buildOwnerFilter, ScopeType } from '../utils/scope.helper';

export function createLeadsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const leadService = new LeadService(prisma);

  // ─── POST /api/v1/leads ───────────────────────────────────────────
  router.post(
    '/',
    authMiddleware,
    permissionMiddleware('lead:create'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const {
          firstName,
          lastName,
          email,
          phone,
          company,
          source,
          notes,
          ownerId,
          score,
          stage,
          expectedValue,
          priority,
          expectedCloseDate,
          country,
          state,
          city,
          area,
          postalCode,
          tagNames,
        } = req.body as {
          firstName: string;
          lastName: string;
          email?: string;
          phone?: string;
          company?: string;
          source?: LeadSource;
          notes?: string;
          ownerId?: string;
          score?: number;
          stage?: LeadStage;
          expectedValue?: number | string;
          priority?: LeadPriority;
          expectedCloseDate?: string;
          country?: string;
          state?: string;
          city?: string;
          area?: string;
          postalCode?: string;
          tagNames?: string[];
        };

        if (!firstName || !lastName) {
          throw new ValidationError('firstName and lastName are required.');
        }

        if (stage && !Object.values(LeadStage).includes(stage)) {
          throw new ValidationError(
            `stage must be one of: ${Object.values(LeadStage).join(', ')}`
          );
        }

        if (priority && !Object.values(LeadPriority).includes(priority)) {
          throw new ValidationError(
            `priority must be one of: ${Object.values(LeadPriority).join(', ')}`
          );
        }

        const lead = await leadService.createLead(
          { tenantId, userId },
          {
            firstName,
            lastName,
            email,
            phone,
            company,
            source,
            notes,
            ownerId,
            score,
            stage,
            expectedValue,
            priority,
            expectedCloseDate,
            country,
            state,
            city,
            area,
            postalCode,
            tagNames: Array.isArray(tagNames) ? tagNames : undefined,
          }
        );

        res.status(201).json({ data: lead });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /api/v1/leads/check-duplicates ──────────────────────────
  // Must be defined before /:id to avoid route conflict
  router.get(
    '/check-duplicates',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { email, phone, company, firstName, lastName, excludeId } = req.query as {
          email?: string;
          phone?: string;
          company?: string;
          firstName?: string;
          lastName?: string;
          excludeId?: string;
        };

        const duplicates = await leadService.checkDuplicates(
          { tenantId, userId: (req as AuthenticatedRequest).user.userId },
          { email, phone, company, firstName, lastName, excludeId }
        );

        res.json({ data: duplicates });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /api/v1/leads ────────────────────────────────────────────
  router.get(
    '/',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          userId,
          tenantId,
          teamId,
          departmentId,
          scope,
        } = (req as AuthenticatedRequest).user;

        const status = req.query.status as LeadStatus | undefined;
        const ownerId = req.query.ownerId as string | undefined;
        const search = req.query.search as string | undefined;
        const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
        const pageSize = req.query.pageSize
          ? parseInt(req.query.pageSize as string, 10)
          : 50;

        if (status && !Object.values(LeadStatus).includes(status)) {
          throw new ValidationError(
            `status must be one of: ${Object.values(LeadStatus).join(', ')}`
          );
        }
        if (page < 1 || isNaN(page)) {
          throw new ValidationError('page must be a positive integer.');
        }
        if (pageSize < 1 || pageSize > 200 || isNaN(pageSize)) {
          throw new ValidationError('pageSize must be between 1 and 200.');
        }

        const ownerFilter = await buildOwnerFilter(
          (scope ?? 'OWN') as ScopeType,
          userId,
          teamId,
          departmentId,
          prisma
        );

        const whereClause: Prisma.LeadWhereInput = {
          tenantId,
          deletedAt: { equals: null },
          ...ownerFilter,
        };

        if (status) whereClause.status = status;
        if (ownerId && !ownerFilter.hasOwnProperty('ownerId')) {
          whereClause.ownerId = ownerId;
        }
        if (search) {
          whereClause.OR = [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { company: { contains: search, mode: 'insensitive' } },
          ];
        }

        const skip = (page - 1) * pageSize;
        const [data, total] = await Promise.all([
          prisma.lead.findMany({
            where: whereClause,
            skip,
            take: pageSize,
            orderBy: { createdAt: 'desc' },
            include: {
              tags: { include: { tag: true } },
            },
          }),
          prisma.lead.count({ where: whereClause }),
        ]);

        const enriched = data.map((l: any) => ({
          ...l,
          tags: (l.tags ?? []).map((a: any) => a.tag),
        }));

        res.json({ data: enriched, total, page, pageSize });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /api/v1/leads/:id ────────────────────────────────────────
  router.get(
    '/:id',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const lead = await leadService.getLeadById({ tenantId, userId }, req.params.id);
        res.json(lead);
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── PUT /api/v1/leads/:id ────────────────────────────────────────
  router.put(
    '/:id',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userReq = req as AuthenticatedRequest;
        const { userId, tenantId, decision } = userReq.user;
        const {
          firstName,
          lastName,
          email,
          phone,
          company,
          source,
          notes,
          ownerId,
          status,
          score,
          stage,
          expectedValue,
          priority,
          expectedCloseDate,
          country,
          state,
          city,
          area,
          postalCode,
          tagNames,
        } = req.body as {
          firstName?: string;
          lastName?: string;
          email?: string;
          phone?: string;
          company?: string;
          source?: LeadSource;
          notes?: string;
          ownerId?: string;
          status?: LeadStatus;
          score?: number;
          stage?: LeadStage;
          expectedValue?: number | string;
          priority?: LeadPriority;
          expectedCloseDate?: string | null;
          country?: string;
          state?: string;
          city?: string;
          area?: string;
          postalCode?: string;
          tagNames?: string[];
        };

        if (stage && !Object.values(LeadStage).includes(stage)) {
          throw new ValidationError(
            `stage must be one of: ${Object.values(LeadStage).join(', ')}`
          );
        }

        if (priority && !Object.values(LeadPriority).includes(priority)) {
          throw new ValidationError(
            `priority must be one of: ${Object.values(LeadPriority).join(', ')}`
          );
        }

        const lead = await leadService.updateLead(
          { tenantId, userId },
          decision,
          req.params.id,
          {
            firstName,
            lastName,
            email,
            phone,
            company,
            source,
            notes,
            ownerId,
            status,
            score,
            stage,
            expectedValue,
            priority,
            expectedCloseDate,
            country,
            state,
            city,
            area,
            postalCode,
            tagNames: Array.isArray(tagNames) ? tagNames : undefined,
          }
        );

        res.json({ data: lead });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── POST /api/v1/leads/:id/convert ──────────────────────────────
  router.post(
    '/:id/convert',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const { contact, opportunity } = req.body as {
          contact: {
            firstName: string;
            lastName: string;
            email?: string;
            phone?: string;
            title?: string;
            company?: string;
          };
          opportunity: {
            title: string;
            value: number;
            currency?: OpportunityCurrency;
            expectedCloseDate?: string;
          };
        };

        if (!contact || !opportunity) {
          throw new ValidationError('contact and opportunity details are required.');
        }
        if (!contact.firstName || !contact.lastName) {
          throw new ValidationError('contact.firstName and contact.lastName are required.');
        }
        if (!opportunity.title || opportunity.value === undefined) {
          throw new ValidationError('opportunity.title and opportunity.value are required.');
        }

        const result = await leadService.convertLead(
          { tenantId, userId },
          req.params.id,
          {
            contact,
            opportunity: {
              ...opportunity,
              expectedCloseDate: opportunity.expectedCloseDate
                ? new Date(opportunity.expectedCloseDate)
                : undefined,
            },
          }
        );

        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── DELETE /api/v1/leads/:id ─────────────────────────────────────
  router.delete(
    '/:id',
    authMiddleware,
    permissionMiddleware('lead:delete'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        await leadService.deleteLead({ tenantId, userId }, req.params.id);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
