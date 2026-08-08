import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ValidationError } from '../types/exceptions';

const VALID_PREFS = new Set(['name', 'company']);

export function createCrmSettingsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ponytail: 'as any' cast — Prisma client locked by running server; regenerate on next restart
  const db = prisma as any;

  // GET /api/v1/settings/crm — returns CRM config for this tenant (auth only, no RBAC)
  router.get('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const row = await db.tenantSettings.findUnique({ where: { tenantId } });
      res.json({ leadHeaderPreference: row?.leadHeaderPreference ?? null });
    } catch (err) { next(err); }
  });

  // POST /api/v1/settings/crm/lead-header — org-level setting; role:manage gate, freely mutable
  router.post(
    '/lead-header',
    authMiddleware,
    permissionMiddleware('role:manage'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { preference } = req.body as { preference?: string };

        if (!preference || !VALID_PREFS.has(preference)) {
          throw new ValidationError('preference must be one of: name, company');
        }

        await db.tenantSettings.upsert({
          where: { tenantId },
          create: { tenantId, leadHeaderPreference: preference },
          update: { leadHeaderPreference: preference },
        });

        res.json({ success: true, leadHeaderPreference: preference });
      } catch (err) { next(err); }
    },
  );

  return router;
}
