import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, OpportunityStage } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { PipelineService } from '../services/pipeline.service';
import { ValidationError } from '../types/exceptions';

export function createPipelineRouter(prisma: PrismaClient): Router {
  const router = Router();
  const pipelineService = new PipelineService(prisma);

  // ─── GET /api/pipeline/analytics ─────────────────────────────────
  /**
   * Get pipeline analytics for the tenant dashboard.
   * Returns: active count, total value, by-stage counts, stage velocity, closure stats.
   */
  router.get('/analytics', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const analytics = await pipelineService.getPipelineAnalytics({ tenantId, userId });
      res.json(analytics);
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/pipeline/stage/:stage ──────────────────────────────
  /**
   * Get all opportunities currently in a specific pipeline stage.
   * Used for kanban board column population.
   */
  router.get('/stage/:stage', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const stage = req.params.stage as OpportunityStage;

      if (!Object.values(OpportunityStage).includes(stage)) {
        throw new ValidationError(`stage must be one of: ${Object.values(OpportunityStage).join(', ')}`);
      }

      const records = await pipelineService.getOpportunitiesByStage({ tenantId, userId }, stage);
      res.json({ stage, opportunities: records, total: records.length });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/pipeline/velocity ───────────────────────────────────
  /** Get average days per stage across all completed transitions */
  router.get('/velocity', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const velocity = await pipelineService.getStageVelocity({ tenantId, userId });
      res.json({ velocity });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/pipeline/opportunities/:id/history ─────────────────
  /** Get the full stage transition history for a specific opportunity */
  router.get('/opportunities/:id/history', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const history = await pipelineService.getOpportunityHistory(
        { tenantId, userId },
        req.params.id
      );
      res.json({ opportunityId: req.params.id, history });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/pipeline/opportunities/:id/current-stage ───────────
  /** Get the current active stage record for an opportunity */
  router.get('/opportunities/:id/current-stage', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const currentStage = await pipelineService.getCurrentStage(
        { tenantId, userId },
        req.params.id
      );
      res.json({ opportunityId: req.params.id, currentStage });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/pipeline/opportunities/:id/predict-close ───────────
  /**
   * Predict the expected closure date for an opportunity
   * based on stage velocity analytics.
   */
  router.get('/opportunities/:id/predict-close', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const predictedDate = await pipelineService.predictClosureDate(
        { tenantId, userId },
        req.params.id
      );
      res.json({ opportunityId: req.params.id, predictedCloseDate: predictedDate });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
