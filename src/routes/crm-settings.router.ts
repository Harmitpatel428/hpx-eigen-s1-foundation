import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ValidationError } from '../types/exceptions';
import { AppException, RetryTag } from '../types/exceptions';

const VALID_PREFS = new Set(['name', 'company', 'phone']);

class AlreadyConfiguredError extends AppException {
  constructor() {
    super(
      'ALREADY_CONFIGURED',
      'Lead header preference is already configured and cannot be changed.',
      RetryTag.NON_RETRYABLE,
      409,
    );
  }
}

export function createCrmSettingsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ponytail: 'as any' casts below — Prisma client locked by running server; regenerate on next restart
  const db = prisma as any;

  // GET /api/v1/settings/crm — returns CRM config for this tenant (auth only, no RBAC)
  router.get('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const row = await db.tenantSettings.findUnique({ where: { tenantId } });
      res.json({ leadHeaderPreference: row?.leadHeaderPreference ?? null });
    } catch (err) { next(err); }
  });

  // POST /api/v1/settings/crm/lead-header — set once; server enforces immutability
  router.post(
    '/lead-header',
    authMiddleware,
    permissionMiddleware('role:manage'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { preference } = req.body as { preference?: string };

        if (!preference || !VALID_PREFS.has(preference)) {
          throw new ValidationError('preference must be one of: name, company, phone');
        }

        const existing = await db.tenantSettings.findUnique({ where: { tenantId } });
        if (existing?.leadHeaderPreference != null) {
          throw new AlreadyConfiguredError();
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
