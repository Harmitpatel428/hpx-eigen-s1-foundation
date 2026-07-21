import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { OpportunityTypesService } from '../services/opportunity-types.service';

export function createOpportunityTypesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = new OpportunityTypesService(prisma);

  router.use(authMiddleware);

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !user.tenantId) {
        res.status(401).json({ message: 'Tenant ID missing from token' });
        return;
      }
      const types = await service.listTypes({ tenantId: user.tenantId, userId: user.userId });
      res.json(types);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !user.tenantId) {
        res.status(401).json({ message: 'Tenant ID missing from token' });
        return;
      }
      const { name } = req.body as { name: string };
      const type = await service.createType({ tenantId: user.tenantId, userId: user.userId }, name);
      res.status(201).json(type);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !user.tenantId) {
        res.status(401).json({ message: 'Tenant ID missing from token' });
        return;
      }
      const { name, isActive } = req.body as { name?: string; isActive?: boolean };
      const type = await service.updateType({ tenantId: user.tenantId, userId: user.userId }, req.params.id, { name, isActive });
      res.json(type);
    } catch (err) {
      next(err);
    }
  });

  router.put('/reorder', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !user.tenantId) {
        res.status(401).json({ message: 'Tenant ID missing from token' });
        return;
      }
      const { typeIds } = req.body as { typeIds: string[] };
      await service.reorderTypes({ tenantId: user.tenantId, userId: user.userId }, typeIds);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !user.tenantId) {
        res.status(401).json({ message: 'Tenant ID missing from token' });
        return;
      }
      await service.deleteType({ tenantId: user.tenantId, userId: user.userId }, req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
