import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';

export function createProcessRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware);

  // ─── GET /api/v1/process/projects ────────────────────────────────
  router.get('/projects', permissionMiddleware('process:projects:read'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, activeDepartmentId } = (req as AuthenticatedRequest).user;
      const db = (req as any).db || prisma;

      const projects = await db.project.findMany({
        where: {
          tenantId,
          departmentId: activeDepartmentId,
          deletedAt: null
        },
        include: { owner: { select: { id: true, identityId: true } } },
        orderBy: { createdAt: 'desc' }
      });

      res.json(projects);
    } catch (err) { next(err); }
  });

  // ─── POST /api/v1/process/projects ───────────────────────────────
  router.post('/projects', permissionMiddleware('lead:create'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, activeDepartmentId, userId } = (req as AuthenticatedRequest).user;
      const db = (req as any).db || prisma;
      const { title, description, status, priority, dueDate, tag } = req.body as {
        title: string;
        description?: string;
        status?: string;
        priority?: string;
        dueDate?: string;
        tag?: string;
      };

      if (!title?.trim()) throw new ValidationError('title is required.');
      if (!activeDepartmentId) throw new ValidationError('No active department context.');

      const project = await db.project.create({
        data: {
          tenantId,
          departmentId: activeDepartmentId,
          ownerId: userId,
          title: title.trim(),
          description: description?.trim(),
          status: status ?? 'ONBOARDING',
          priority: priority ?? 'MEDIUM',
          dueDate: dueDate ? new Date(dueDate) : null,
          tag: tag?.trim() ?? null
        }
      });

      res.status(201).json(project);
    } catch (err) { next(err); }
  });

  // ─── GET /api/v1/process/projects/:id ────────────────────────────
  router.get('/projects/:id', permissionMiddleware('lead:view'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, activeDepartmentId } = (req as AuthenticatedRequest).user;
      const db = (req as any).db || prisma;

      const project = await db.project.findFirst({
        where: { id: req.params.id, tenantId, departmentId: activeDepartmentId, deletedAt: null }
      });

      if (!project) throw new ResourceNotFoundError();
      res.json(project);
    } catch (err) { next(err); }
  });

  // ─── PATCH /api/v1/process/projects/:id ──────────────────────────
  router.patch('/projects/:id', permissionMiddleware('lead:edit'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, activeDepartmentId } = (req as AuthenticatedRequest).user;
      const db = (req as any).db || prisma;
      const { title, description, status, priority, dueDate, tag } = req.body as Record<string, string | undefined>;

      const existing = await db.project.findFirst({
        where: { id: req.params.id, tenantId, departmentId: activeDepartmentId, deletedAt: null }
      });
      if (!existing) throw new ResourceNotFoundError();

      const updated = await db.project.update({
        where: { id: req.params.id },
        data: {
          title: title?.trim() ?? undefined,
          description: description?.trim() ?? undefined,
          status: status ?? undefined,
          priority: priority ?? undefined,
          dueDate: dueDate ? new Date(dueDate) : undefined,
          tag: tag?.trim() ?? undefined
        }
      });

      res.json(updated);
    } catch (err) { next(err); }
  });

  // ─── DELETE /api/v1/process/projects/:id ─────────────────────────
  router.delete('/projects/:id', permissionMiddleware('lead:delete'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, activeDepartmentId } = (req as AuthenticatedRequest).user;
      const db = (req as any).db || prisma;

      const existing = await db.project.findFirst({
        where: { id: req.params.id, tenantId, departmentId: activeDepartmentId, deletedAt: null }
      });
      if (!existing) throw new ResourceNotFoundError();

      await db.project.update({
        where: { id: req.params.id },
        data: { deletedAt: new Date() }
      });

      res.status(204).send();
    } catch (err) { next(err); }
  });

  return router;
}
