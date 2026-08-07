import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';

export function createLeadTagsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.use(authMiddleware);

  // ─── GET /api/v1/lead-tags ────────────────────────────────────────
  /** List all active tags for the current tenant, ordered by usage. */
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const search = req.query.search as string | undefined;

      const tags = await (prisma as any).leadTag.findMany({
        where: {
          tenantId,
          deletedAt: { equals: null },
          ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
        },
        orderBy: [{ usageCount: 'desc' }, { name: 'asc' }],
        take: 50,
        select: { id: true, name: true, color: true, usageCount: true },
      });

      res.json({ data: tags });
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/v1/lead-tags ───────────────────────────────────────
  /** Create a new tag (or return existing one by name). */
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const { name, color } = req.body as { name?: string; color?: string };

      if (!name?.trim()) {
        throw new ValidationError('name is required.');
      }

      const tag = await (prisma as any).leadTag.upsert({
        where: { tenantId_name: { tenantId, name: name.trim() } },
        create: {
          tenantId,
          name: name.trim(),
          color: color ?? '#6366f1',
        },
        update: { color: color ?? undefined },
        select: { id: true, name: true, color: true, usageCount: true },
      });

      res.status(201).json({ data: tag });
    } catch (err) {
      next(err);
    }
  });

  // ─── DELETE /api/v1/lead-tags/:id ────────────────────────────────
  /** Soft-delete a tag and remove all its lead assignments. */
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const tag = await (prisma as any).leadTag.findFirst({
        where: { id: req.params.id, tenantId, deletedAt: { equals: null } },
      });

      if (!tag) throw new ResourceNotFoundError();

      await (prisma as any).$transaction([
        (prisma as any).leadTagAssignment.deleteMany({ where: { tagId: req.params.id } }),
        (prisma as any).leadTag.update({
          where: { id: req.params.id },
          data: { deletedAt: new Date() },
        }),
      ]);

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
