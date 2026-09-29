import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from './auth.middleware';
import { CaseOperationsEngineDisabledError } from '../types/exceptions';

/**
 * Gate: the Case Operations Engine must be enabled for the caller's tenant.
 * Mount AFTER authMiddleware (needs req.user.tenantId) and BEFORE permissionMiddleware.
 * Missing TenantSettings row or flag=false -> 403 CASE_OPERATIONS_ENGINE_DISABLED.
 */
export function requireCaseEngineEnabled(prisma: PrismaClient) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const row = await prisma.tenantSettings.findUnique({
        where: { tenantId },
        select: { caseOperationsEngineEnabled: true },
      });
      if (!row?.caseOperationsEngineEnabled) {
        throw new CaseOperationsEngineDisabledError();
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
