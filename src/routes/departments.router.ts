import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';

export function createDepartmentsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.use(authMiddleware);

  // ─── GET /api/v1/departments ──────────────────────────────────────
  /** List all departments for the caller's tenant */
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const departments = await prisma.department.findMany({
        where: { tenantId },
        select: {
          id: true,
          name: true,
          parentId: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { users: true } },
        },
        orderBy: { name: 'asc' },
      });

      res.json(departments);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/v1/departments ─────────────────────────────────────
  /** Create a new department */
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const { name, parentId } = req.body as { name: string; parentId?: string };

      if (!name || name.trim().length === 0) {
        throw new ValidationError('name is required.');
      }

      // Validate parentId belongs to same tenant if provided
      if (parentId) {
        const parent = await prisma.department.findFirst({
          where: { id: parentId, tenantId },
        });
        if (!parent) throw new ValidationError('parentId references a non-existent department.');
      }

      const department = await prisma.department.create({
        data: {
          tenantId,
          name: name.trim(),
          parentId: parentId ?? null,
        },
        select: {
          id: true,
          name: true,
          parentId: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      res.status(201).json(department);
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT /api/v1/departments/:id ──────────────────────────────────
  /** Update department name or parent */
  router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const { name, parentId } = req.body as { name?: string; parentId?: string | null };

      const existing = await prisma.department.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!existing) throw new ResourceNotFoundError();

      // Prevent circular parent reference
      if (parentId && parentId === req.params.id) {
        throw new ValidationError('A department cannot be its own parent.');
      }

      const department = await prisma.department.update({
        where: { id: req.params.id },
        data: {
          name: name ? name.trim() : undefined,
          parentId: parentId === null ? null : (parentId ?? undefined),
        },
        select: {
          id: true,
          name: true,
          parentId: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      res.json(department);
    } catch (err) {
      next(err);
    }
  });

  // ─── DELETE /api/v1/departments/:id ──────────────────────────────
  /** Delete a department (physical delete — no soft-delete for org entities) */
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const existing = await prisma.department.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!existing) throw new ResourceNotFoundError();

      // Unlink users from this department before deleting
      await prisma.user.updateMany({
        where: { departmentId: req.params.id, tenantId },
        data: { departmentId: null },
      });

      await prisma.department.delete({ where: { id: req.params.id } });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
