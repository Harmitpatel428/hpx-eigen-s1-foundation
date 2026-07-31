import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, ActivityType } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ActivityService } from '../services/activity.service';
import { ValidationError } from '../types/exceptions';

export function createActivitiesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const activityService = new ActivityService(prisma);

  // ─── POST /api/activities ─────────────────────────────────────────
  /** Log a new activity against an opportunity */
  router.post('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId, activeDepartmentId } = (req as AuthenticatedRequest).user;
      const { opportunityId, type, subject, notes, scheduledAt } = req.body as {
        opportunityId: string;
        type: ActivityType;
        subject: string;
        notes?: string;
        scheduledAt?: string;
      };

      if (!opportunityId || !type || !subject) {
        throw new ValidationError('opportunityId, type, and subject are required.');
      }

      const activity = await activityService.createActivity(
        (req as any).db || prisma, { tenantId, userId, activeDepartmentId },
        {
          opportunityId,
          userId,
          type,
          subject,
          notes,
          scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined
        }
      );

      res.status(201).json(activity);
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/activities ──────────────────────────────────────────
  /** List activities filtered by opportunityId, type, or userId */
  router.get('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId, activeDepartmentId } = (req as AuthenticatedRequest).user;
      const opportunityId = req.query.opportunityId as string | undefined;
      const type = req.query.type as ActivityType | undefined;
      const actorUserId = req.query.actorUserId as string | undefined;

      let activities;

      if (opportunityId) {
        activities = await activityService.listByOpportunity((req as any).db || prisma, { tenantId, userId, activeDepartmentId }, opportunityId);
      } else if (type) {
        if (!Object.values(ActivityType).includes(type)) {
          throw new ValidationError(`type must be one of: ${Object.values(ActivityType).join(', ')}`);
        }
        activities = await activityService.listByType((req as any).db || prisma, { tenantId, userId, activeDepartmentId }, type);
      } else if (actorUserId) {
        activities = await activityService.listByUser((req as any).db || prisma, { tenantId, userId, activeDepartmentId }, actorUserId);
      } else {
        // Default: activities for the current user
        activities = await activityService.listByUser((req as any).db || prisma, { tenantId, userId, activeDepartmentId }, userId);
      }

      res.json({ data: activities, total: activities.length });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/activities/:id ──────────────────────────────────────
  /** Get a single activity by ID */
  router.get('/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId, activeDepartmentId } = (req as AuthenticatedRequest).user;
      const activity = await activityService.getActivityById((req as any).db || prisma, { tenantId, userId, activeDepartmentId }, req.params.id);
      res.json(activity);
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT /api/activities/:id ──────────────────────────────────────
  /** Update activity details */
  router.put('/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId, activeDepartmentId } = (req as AuthenticatedRequest).user;
      const { subject, notes, scheduledAt, completedAt } = req.body as {
        subject?: string;
        notes?: string;
        scheduledAt?: string;
        completedAt?: string;
      };

      const activity = await activityService.updateActivity(
        (req as any).db || prisma, { tenantId, userId, activeDepartmentId },
        req.params.id,
        {
          subject,
          notes,
          scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
          completedAt: completedAt ? new Date(completedAt) : undefined
        }
      );

      res.json(activity);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/activities/:id/complete ────────────────────────────
  /** Mark an activity as complete */
  router.post('/:id/complete', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId, activeDepartmentId } = (req as AuthenticatedRequest).user;
      const activity = await activityService.markActivityComplete((req as any).db || prisma, { tenantId, userId, activeDepartmentId }, req.params.id);
      res.json(activity);
    } catch (err) {
      next(err);
    }
  });

  // ─── DELETE /api/activities/:id ───────────────────────────────────
  /** Soft-delete an activity */
  router.delete('/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId, activeDepartmentId } = (req as AuthenticatedRequest).user;
      await activityService.deleteActivity((req as any).db || prisma, { tenantId, userId, activeDepartmentId }, req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
