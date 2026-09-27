import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { AuditService } from '../services/audit.service';
import { ValidationError } from '../types/exceptions';

const VALID_PREFS = new Set(['name', 'company']);

export function createCrmSettingsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const auditService = new AuditService(prisma);

  // GET /api/v1/settings/crm — returns CRM config for this tenant (auth only, no RBAC)
  router.get('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const row = await prisma.tenantSettings.findUnique({ where: { tenantId } });
      res.json({
        leadHeaderPreference: row?.leadHeaderPreference ?? 'name',
        allowImpersonation: row?.allowImpersonation ?? false,
        caseOperationsEngineEnabled: row?.caseOperationsEngineEnabled ?? false,
      });
    } catch (err) { next(err); }
  });

  // reg #10 (WP-1 PR-1): the admin-impersonation toggle POST is removed with the feature.
  // The GET above still surfaces `allowImpersonation` (now inert) so the settings response
  // shape is unchanged for the frontend; the TenantSettings column is retained, never written,
  // until the Phase-12 support-access cutover.

  // POST /api/v1/settings/crm/lead-header — org-level setting; role:manage gate, freely mutable
  router.post(
    '/lead-header',
    authMiddleware,
    permissionMiddleware('role:manage'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { preference } = req.body as { preference?: string };

        if (!preference || !VALID_PREFS.has(preference)) {
          throw new ValidationError('preference must be one of: name, company');
        }

        const before = await prisma.tenantSettings.findUnique({ where: { tenantId } });

        await prisma.tenantSettings.upsert({
          where: { tenantId },
          create: { tenantId, leadHeaderPreference: preference },
          update: { leadHeaderPreference: preference },
        });

        try {
          await auditService.log({
            tenantId,
            eventType: 'TENANT_SETTINGS_UPDATED',
            entityType: 'TenantSettings',
            entityId: tenantId,
            actorUserId: userId,
            actorIp: req.ip,
            actorUserAgent: req.headers['user-agent'],
            operation: 'UPDATE_LEAD_HEADER_PREFERENCE',
            payload: { leadHeaderPreference: preference },
            beforeState: { leadHeaderPreference: before?.leadHeaderPreference ?? 'name' },
          });
        } catch (e) {
          console.error('[AUDIT_DELIVERY_FAILURE]', e);
        }

        res.json({ success: true, leadHeaderPreference: preference });
      } catch (err) { next(err); }
    },
  );

  // POST /api/v1/settings/crm/case-operations-engine — tenant kill switch; case-engine:manage gate
  router.post(
    '/case-operations-engine',
    authMiddleware,
    permissionMiddleware('case-engine:manage'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { enabled } = req.body as { enabled?: unknown };

        if (typeof enabled !== 'boolean') {
          throw new ValidationError('enabled must be a boolean');
        }

        const userAgent = Array.isArray(req.headers['user-agent'])
          ? req.headers['user-agent'][0]
          : req.headers['user-agent'];

        await prisma.$transaction(async (tx) => {
          const before = await tx.tenantSettings.findUnique({ where: { tenantId } });

          await tx.tenantSettings.upsert({
            where: { tenantId },
            create: { tenantId, caseOperationsEngineEnabled: enabled },
            update: { caseOperationsEngineEnabled: enabled },
          });

          await auditService.appendInTx(tx, {
            tenantId,
            eventType: 'TENANT_ENGINE_FLAG_UPDATED',
            entityType: 'TenantSettings',
            entityId: tenantId,
            actorUserId: userId,
            actorIp: req.ip,
            actorUserAgent: userAgent,
            operation: 'UPDATE',
            payload: { enabled },
            beforeState: { caseOperationsEngineEnabled: before?.caseOperationsEngineEnabled ?? false },
          });
        }, { maxWait: 5000, timeout: 15000 });

        res.json({ success: true, caseOperationsEngineEnabled: enabled });
      } catch (err) { next(err); }
    },
  );

  return router;
}
