import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';

export function createDocsRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware);

  // ─── GET /api/v1/docs/documents ──────────────────────────────────
  router.get('/documents', permissionMiddleware('docs:documents:read'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, activeDepartmentId } = (req as AuthenticatedRequest).user;
      const db = (req as any).db || prisma;
      const { status, category, search } = req.query as Record<string, string | undefined>;

      const where: Record<string, any> = {
        tenantId,
        departmentId: activeDepartmentId,
        deletedAt: null
      };

      if (status) where.status = status;
      if (category) where.category = category;
      if (search) {
        where.title = { contains: search, mode: 'insensitive' };
      }

      const documents = await db.document.findMany({
        where,
        include: {
          owner: { select: { id: true, identityId: true } }
        },
        orderBy: { updatedAt: 'desc' }
      });

      res.json(documents);
    } catch (err) { next(err); }
  });

  // ─── POST /api/v1/docs/documents ─────────────────────────────────
  router.post('/documents', permissionMiddleware('lead:create'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, activeDepartmentId, userId } = (req as AuthenticatedRequest).user;
      const db = (req as any).db || prisma;
      const { title, status, category } = req.body as {
        title: string;
        status?: string;
        category?: string;
      };

      if (!title?.trim()) throw new ValidationError('title is required.');
      if (!activeDepartmentId) throw new ValidationError('No active department context.');

      const document = await db.document.create({
        data: {
          tenantId,
          departmentId: activeDepartmentId,
          ownerId: userId,
          title: title.trim(),
          status: status ?? 'DRAFT',
          version: 1,
          category: category?.trim() ?? null
        }
      });

      res.status(201).json(document);
    } catch (err) { next(err); }
  });

  // ─── GET /api/v1/docs/documents/:id ──────────────────────────────
  router.get('/documents/:id', permissionMiddleware('lead:view'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, activeDepartmentId } = (req as AuthenticatedRequest).user;
      const db = (req as any).db || prisma;

      const document = await db.document.findFirst({
        where: { id: req.params.id, tenantId, departmentId: activeDepartmentId, deletedAt: null }
      });

      if (!document) throw new ResourceNotFoundError();
      res.json(document);
    } catch (err) { next(err); }
  });

  // ─── PATCH /api/v1/docs/documents/:id ────────────────────────────
  router.patch('/documents/:id', permissionMiddleware('lead:edit'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, activeDepartmentId } = (req as AuthenticatedRequest).user;
      const db = (req as any).db || prisma;
      const { title, status, category } = req.body as Record<string, string | undefined>;

      const existing = await db.document.findFirst({
        where: { id: req.params.id, tenantId, departmentId: activeDepartmentId, deletedAt: null }
      });
      if (!existing) throw new ResourceNotFoundError();

      // Bump version on any title or status update
      const shouldBumpVersion = !!(title || status);

      const updated = await db.document.update({
        where: { id: req.params.id },
        data: {
          title: title?.trim() ?? undefined,
          status: status ?? undefined,
          category: category?.trim() ?? undefined,
          version: shouldBumpVersion ? { increment: 1 } : undefined
        }
      });

      res.json(updated);
    } catch (err) { next(err); }
  });

  // ─── DELETE /api/v1/docs/documents/:id ───────────────────────────
  router.delete('/documents/:id', permissionMiddleware('lead:delete'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, activeDepartmentId } = (req as AuthenticatedRequest).user;
      const db = (req as any).db || prisma;

      const existing = await db.document.findFirst({
        where: { id: req.params.id, tenantId, departmentId: activeDepartmentId, deletedAt: null }
      });
      if (!existing) throw new ResourceNotFoundError();

      await db.document.update({
        where: { id: req.params.id },
        data: { deletedAt: new Date() }
      });

      res.status(204).send();
    } catch (err) { next(err); }
  });

  return router;
}
