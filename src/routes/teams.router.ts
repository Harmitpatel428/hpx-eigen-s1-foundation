import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';

export function createTeamsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.use(authMiddleware);

  // ─── GET /api/v1/teams ────────────────────────────────────────────
  /** List all teams for the caller's tenant */
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const teams = await prisma.team.findMany({
        where: { tenantId },
        select: {
          id: true,
          name: true,
          departmentId: true,
          _count: { select: { users: true } },
        },
        orderBy: { name: 'asc' },
      });

      res.json(teams);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/v1/teams ───────────────────────────────────────────
  /** Create a new team */
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const { name, departmentId } = req.body as {
        name: string;
        departmentId?: string;
      };

      if (!name || name.trim().length === 0) {
        throw new ValidationError('name is required.');
      }

      // Validate departmentId belongs to same tenant if provided
      if (departmentId) {
        const dept = await prisma.department.findFirst({
          where: { id: departmentId, tenantId },
        });
        if (!dept) throw new ValidationError('departmentId references a non-existent department.');
      }

      const team = await prisma.team.create({
        data: {
          tenantId,
          name: name.trim(),
          departmentId: departmentId ?? null,
        },
        select: {
          id: true,
          name: true,
          departmentId: true,
        },
      });

      res.status(201).json(team);
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT /api/v1/teams/:id ────────────────────────────────────────
  /** Update team name or department */
  router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const { name, departmentId } = req.body as {
        name?: string;
        departmentId?: string | null;
      };

      const existing = await prisma.team.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!existing) throw new ResourceNotFoundError();

      const team = await prisma.team.update({
        where: { id: req.params.id },
        data: {
          name: name ? name.trim() : undefined,
          departmentId: departmentId === null ? null : (departmentId ?? undefined),
        },
        select: {
          id: true,
          name: true,
          departmentId: true,
        },
      });

      res.json(team);
    } catch (err) {
      next(err);
    }
  });

  // ─── DELETE /api/v1/teams/:id ─────────────────────────────────────
  /** Delete a team (physical delete) */
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const existing = await prisma.team.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!existing) throw new ResourceNotFoundError();

      // Unlink users from this team before deleting
      await prisma.user.updateMany({
        where: { teamId: req.params.id, tenantId },
        data: { teamId: null },
      });

      await prisma.team.delete({ where: { id: req.params.id } });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/v1/teams/:id/members ──────────────────────────────
  /** Assign a user to a team */
  router.post('/:id/members', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const { userId } = req.body as { userId: string };

      if (!userId) throw new ValidationError('userId is required.');

      const team = await prisma.team.findFirst({ where: { id: req.params.id, tenantId } });
      if (!team) throw new ResourceNotFoundError();

      const user = await prisma.user.findFirst({
        where: { id: userId, tenantId, deletedAt: null },
      });
      if (!user) throw new ValidationError('userId references a non-existent user.');

      await prisma.user.update({
        where: { id: userId },
        data: { teamId: req.params.id },
      });

      res.status(200).json({ message: 'User assigned to team.' });
    } catch (err) {
      next(err);
    }
  });

  // ─── DELETE /api/v1/teams/:id/members/:userId ─────────────────────
  /** Remove a user from a team */
  router.delete('/:id/members/:userId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const team = await prisma.team.findFirst({ where: { id: req.params.id, tenantId } });
      if (!team) throw new ResourceNotFoundError();

      await prisma.user.updateMany({
        where: { id: req.params.userId, teamId: req.params.id, tenantId },
        data: { teamId: null },
      });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
