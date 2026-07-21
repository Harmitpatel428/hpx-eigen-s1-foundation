import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, PaymentMethod } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { PaymentService } from '../services/payment.service';
import { ValidationError } from '../types/exceptions';

export function createPaymentsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const paymentService = new PaymentService(prisma);
  
  router.use(authMiddleware);

  // ─── GET /api/v1/payments ───────────────────────────────────────────
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !user.tenantId) {
        res.status(401).json({ message: 'Tenant ID missing from token' });
        return;
      }
      const { userId, tenantId } = user;
      const method = req.query.method as PaymentMethod | undefined;
      const invoiceId = req.query.invoiceId as string | undefined;

      if (method && !Object.values(PaymentMethod).includes(method)) {
        throw new ValidationError(`method must be one of: ${Object.values(PaymentMethod).join(', ')}`);
      }

      const payments = await paymentService.listPayments(
        { tenantId, userId },
        { method, invoiceId }
      );

      res.json({ data: payments, total: payments.length });
    } catch (err: any) {
      console.error('Error fetching payments:', err);
      res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
  });

  // ─── GET /api/v1/payments/:id ───────────────────────────────────────
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const payment = await paymentService.getPaymentById({ tenantId, userId }, req.params.id);
      res.json(payment);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/v1/payments ──────────────────────────────────────────
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user || !user.tenantId) {
        res.status(401).json({ message: 'Tenant ID missing from token' });
        return;
      }
      const { userId, tenantId } = user;
      const { invoiceId, amount, method, paidAt } = req.body as {
        invoiceId: string;
        amount: number | string;
        method?: PaymentMethod;
        paidAt?: string;
      };

      if (!invoiceId || amount === undefined) {
        throw new ValidationError('invoiceId and amount are required.');
      }

      const isUUID = (str: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
      if (!isUUID(invoiceId)) {
        throw new ValidationError('invoiceId must be a valid UUID.');
      }

      const numericAmount = typeof amount === 'string' ? parseFloat(amount.replace(/,/g, '')) : amount;
      if (isNaN(numericAmount)) {
        throw new ValidationError('Amount must be a valid number.');
      }
      
      const parsedPaidAt = paidAt ? new Date(paidAt) : undefined;
      if (parsedPaidAt && isNaN(parsedPaidAt.getTime())) {
        throw new ValidationError('Invalid paidAt format.');
      }

      const payment = await paymentService.createPayment(
        { tenantId, userId },
        {
          invoiceId,
          amount: numericAmount,
          method,
          paidAt: parsedPaidAt
        }
      );

      res.status(201).json(payment);
    } catch (err: any) {
      console.error('Error creating payment:', err);
      res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
  });

  // ─── DELETE /api/v1/payments/:id ────────────────────────────────────
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      await paymentService.deletePayment({ tenantId, userId }, req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
