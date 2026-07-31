import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { PaymentService } from '../services/payment.service';
import { validate } from '../middleware/validate.middleware';
import {
  createPaymentSchema,
  updatePaymentSchema,
  listPaymentsSchema,
  paymentIdSchema,
} from '../schemas/payment.schema';

export function createPaymentsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const paymentService = new PaymentService(prisma);

  router.use(authMiddleware);

  // ─── GET /api/v1/payments ───────────────────────────────────────────
  router.get('/', validate(listPaymentsSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId, } = (req as AuthenticatedRequest).user;
      const { method, invoiceId } = req.query as { method?: any; invoiceId?: string };

      const payments = await paymentService.listPayments(
        (req as any).db || prisma, { tenantId, userId, },
        { method, invoiceId }
      );

      res.json({ data: payments, total: payments.length });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/v1/payments/:id ───────────────────────────────────────
  router.get('/:id', validate(paymentIdSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId, } = (req as AuthenticatedRequest).user;
      const payment = await paymentService.getPaymentById((req as any).db || prisma, { tenantId, userId, }, req.params.id);
      res.json(payment);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/v1/payments ──────────────────────────────────────────
  router.post('/', validate(createPaymentSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId, } = (req as AuthenticatedRequest).user;
      const payment = await paymentService.createPayment((req as any).db || prisma, { tenantId, userId, }, req.body);
      res.status(201).json(payment);
    } catch (err) {
      next(err);
    }
  });

  // ─── PATCH /api/v1/payments/:id ─────────────────────────────────────
  router.patch('/:id', validate(updatePaymentSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId, } = (req as AuthenticatedRequest).user;
      const payment = await paymentService.updatePayment(
        (req as any).db || prisma, { tenantId, userId, },
        req.params.id,
        req.body
      );
      res.json(payment);
    } catch (err) {
      next(err);
    }
  });

  // ─── DELETE /api/v1/payments/:id ────────────────────────────────────
  router.delete('/:id', validate(paymentIdSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId, } = (req as AuthenticatedRequest).user;
      await paymentService.deletePayment((req as any).db || prisma, { tenantId, userId, }, req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
