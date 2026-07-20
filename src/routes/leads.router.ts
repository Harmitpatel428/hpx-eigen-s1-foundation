import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, LeadStatus, LeadSource, OpportunityCurrency } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { LeadService } from '../services/lead.service';
import { ValidationError } from '../types/exceptions';

export function createLeadsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const leadService = new LeadService(prisma);

  // ─── POST /api/leads ──────────────────────────────────────────────
  /** Create a new lead */
  router.post('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const { firstName, lastName, email, phone, company, source, notes, ownerId } = req.body as {
        firstName: string;
        lastName: string;
        email?: string;
        phone?: string;
        company?: string;
        source?: LeadSource;
        notes?: string;
        ownerId?: string;
      };

      if (!firstName || !lastName) {
        throw new ValidationError('firstName and lastName are required.');
      }

      const lead = await leadService.createLead(
        { tenantId, userId },
        { firstName, lastName, email, phone, company, source, notes, ownerId }
      );

      res.status(201).json(lead);
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/leads ───────────────────────────────────────────────
  /** List leads (optionally filtered by status or ownerId) */
  router.get('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const status = req.query.status as LeadStatus | undefined;
      const ownerId = req.query.ownerId as string | undefined;

      if (status && !Object.values(LeadStatus).includes(status)) {
        throw new ValidationError(`status must be one of: ${Object.values(LeadStatus).join(', ')}`);
      }

      const leads = await leadService.listLeads({ tenantId, userId }, { status, ownerId });
      res.json({ data: leads, total: leads.length });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/leads/:id ───────────────────────────────────────────
  /** Get a single lead by ID */
  router.get('/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const lead = await leadService.getLeadById({ tenantId, userId }, req.params.id);
      res.json(lead);
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT /api/leads/:id ───────────────────────────────────────────
  /** Update lead fields */
  router.put('/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const { firstName, lastName, email, phone, company, source, notes, ownerId, status } = req.body as {
        firstName?: string;
        lastName?: string;
        email?: string;
        phone?: string;
        company?: string;
        source?: LeadSource;
        notes?: string;
        ownerId?: string;
        status?: LeadStatus;
      };

      const lead = await leadService.updateLead(
        { tenantId, userId },
        req.params.id,
        { firstName, lastName, email, phone, company, source, notes, ownerId, status }
      );

      res.json(lead);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/leads/:id/convert ──────────────────────────────────
  /**
   * Convert a lead to a Contact + Opportunity.
   * Body: { contact: {...}, opportunity: {...} }
   */
  router.post('/:id/convert', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
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
              : undefined
          }
        }
      );

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // ─── DELETE /api/leads/:id ────────────────────────────────────────
  /** Soft-delete a lead */
  router.delete('/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      await leadService.deleteLead({ tenantId, userId }, req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
