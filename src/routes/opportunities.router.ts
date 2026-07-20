import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, OpportunityStage, OpportunityCurrency } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { OpportunityService } from '../services/opportunity.service';
import { ValidationError } from '../types/exceptions';

export function createOpportunitiesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const opportunityService = new OpportunityService(prisma);

  // ─── POST /api/opportunities ──────────────────────────────────────
  /** Create a new opportunity linked to a lead */
  router.post('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const { leadId, contactId, ownerId, title, value, currency, expectedCloseDate } = req.body as {
        leadId: string;
        contactId?: string;
        ownerId?: string;
        title: string;
        value: number | string;
        currency?: OpportunityCurrency;
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
          expectedCloseDate: expectedCloseDate ? new Date(expectedCloseDate) : undefined
        }
      );

      res.status(201).json(opportunity);
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/opportunities ───────────────────────────────────────
  /** List opportunities (optionally filtered by stage or ownerId) */
  router.get('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const stage = req.query.stage as OpportunityStage | undefined;
      const ownerId = req.query.ownerId as string | undefined;

      if (stage && !Object.values(OpportunityStage).includes(stage)) {
        throw new ValidationError(`stage must be one of: ${Object.values(OpportunityStage).join(', ')}`);
      }

      const opportunities = await opportunityService.listOpportunities(
        { tenantId, userId },
        { stage, ownerId }
      );

      res.json({ data: opportunities, total: opportunities.length });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/opportunities/:id ───────────────────────────────────
  /** Get a single opportunity by ID (includes lead + contact summary) */
  router.get('/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
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
  });

  // ─── PUT /api/opportunities/:id ───────────────────────────────────
  /** Update opportunity metadata */
  router.put('/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const { contactId, ownerId, title, value, currency, expectedCloseDate } = req.body as {
        contactId?: string;
        ownerId?: string;
        title?: string;
        value?: number | string;
        currency?: OpportunityCurrency;
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
          expectedCloseDate: expectedCloseDate ? new Date(expectedCloseDate) : undefined
        }
      );

      res.json(opportunity);
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT /api/opportunities/:id/stage ────────────────────────────
  /**
   * Advance an opportunity to a new pipeline stage.
   * Body: { stage: OpportunityStage, lostReason?: string }
   */
  router.put('/:id/stage', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const { stage, lostReason } = req.body as { stage: OpportunityStage; lostReason?: string };

      if (!stage) {
        throw new ValidationError('stage is required.');
      }

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
  });

  // ─── POST /api/opportunities/:id/close ───────────────────────────
  /**
   * Close an opportunity as WON or LOST.
   * Body: { outcome: 'WON' | 'LOST', lostReason?: string }
   */
  router.post('/:id/close', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
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
  });

  // ─── DELETE /api/opportunities/:id ───────────────────────────────
  /** Soft-delete an opportunity */
  router.delete('/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      await opportunityService.deleteOpportunity({ tenantId, userId }, req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
