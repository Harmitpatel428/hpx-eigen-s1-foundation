import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';

export function createAuditRouter(prisma: PrismaClient): Router {
  const router = Router();

  // Globally protect all audit routes with authMiddleware
  router.use(authMiddleware);

  // ─── GET /api/v1/audit-logs ─────────────────────────────────────────
  /**
   * List immutable audit logs for the caller's tenant.
   * Query params: page (default 1), pageSize (default 50, max 100), actorUserId, entityType.
   * Returns standardized pagination envelope with strict field masking.
   */
  router.get(
    '/',
    permissionMiddleware('audit:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;

        const pageNum = Math.max(1, parseInt(req.query.page as string, 10) || 1);
        const rawPageSize = parseInt(req.query.pageSize as string, 10) || 50;
        const pageSizeNum = Math.min(100, Math.max(1, rawPageSize));

        const actorUserId = req.query.actorUserId ? String(req.query.actorUserId) : undefined;
        const entityType = req.query.entityType ? String(req.query.entityType) : undefined;

        const whereClause: Prisma.AuditLogWhereInput = {
          tenantId,
          ...(actorUserId ? { actorUserId } : {}),
          ...(entityType ? { entityType } : {}),
        };

        const [data, total] = await Promise.all([
          prisma.auditLog.findMany({
            where: whereClause,
            orderBy: { createdAt: 'desc' },
            skip: (pageNum - 1) * pageSizeNum,
            take: pageSizeNum,
            // STRICT SELECT: Prevent leaking payload bloat or sensitive relations
            select: {
              id: true,
              eventType: true,
              entityType: true,
              entityId: true,
              actorUserId: true,
              operation: true,
              createdAt: true,
            },
          }),
          prisma.auditLog.count({ where: whereClause }),
        ]);

        res.json({
          data,
          total,
          page: pageNum,
          pageSize: pageSizeNum,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
