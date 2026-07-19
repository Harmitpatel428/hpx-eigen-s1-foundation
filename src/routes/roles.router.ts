import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ValidationError, DuplicateResourceError } from '../types/exceptions';

export function createRolesRouter(prisma: PrismaClient): Router {
  const router = Router();

  // All role routes require authentication
  router.use(authMiddleware);

  // ─── GET /api/roles ───────────────────────────────────────────────
  /** List all non-deleted roles in the caller's tenant */
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;

      const roles = await prisma.role.findMany({
        where: { tenantId, deletedAt: null },
        select: {
          id: true,
          name: true,
          description: true,
          createdAt: true,
          _count: {
            select: { userRoles: true }
          }
        },
        orderBy: { name: 'asc' }
      });

      res.json(roles);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/roles ──────────────────────────────────────────────
  /**
   * Create a new role in the caller's tenant.
   * Body: { name: string, description?: string }
   * Returns: { id, name, description, createdAt }
   */
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const { name, description } = req.body as { name: string; description?: string };

      if (!name || name.trim().length === 0) {
        throw new ValidationError('name is required.');
      }

      // Check uniqueness within tenant
      const existing = await prisma.role.findFirst({
        where: { tenantId, name: name.trim(), deletedAt: null }
      });
      if (existing) throw new DuplicateResourceError();

      const role = await prisma.role.create({
        data: {
          tenantId,
          name: name.trim(),
          description: description?.trim() ?? null
        },
        select: {
          id: true,
          name: true,
          description: true,
          createdAt: true
        }
      });

      res.status(201).json(role);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
