import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth.middleware';

export function createInvoicesRouter(prisma: PrismaClient): Router {
  const router = Router();
  
  router.use(authMiddleware);

  // GET /api/v1/invoices
  router.get('/', async (req, res, next) => {
    try {
      res.json({ data: [] });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/invoices
  router.post('/', async (req, res, next) => {
    try {
      res.status(201).json({ data: null });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
