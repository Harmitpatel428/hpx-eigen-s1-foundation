import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, InvoiceStatus } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { InvoiceService } from '../services/invoice.service';
import { ValidationError } from '../types/exceptions';

export function createInvoicesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const invoiceService = new InvoiceService(prisma);
  
  router.use(authMiddleware);

  // ─── GET /api/v1/invoices ───────────────────────────────────────────
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const status = req.query.status as InvoiceStatus | undefined;
      const opportunityId = req.query.opportunityId as string | undefined;

      if (status && !Object.values(InvoiceStatus).includes(status)) {
        throw new ValidationError(`status must be one of: ${Object.values(InvoiceStatus).join(', ')}`);
      }

      const invoices = await invoiceService.listInvoices(
        { tenantId, userId },
        { status, opportunityId }
      );

      res.json({ data: invoices, total: invoices.length });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/v1/invoices/:id ───────────────────────────────────────
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const invoice = await invoiceService.getInvoiceById({ tenantId, userId }, req.params.id);
      res.json(invoice);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /api/v1/invoices ──────────────────────────────────────────
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const { opportunityId, amount, status, dueDate } = req.body as {
        opportunityId: string;
        amount: number | string;
        status?: InvoiceStatus;
        dueDate?: string;
      };

      if (!opportunityId || amount === undefined) {
        throw new ValidationError('opportunityId and amount are required.');
      }

      const invoice = await invoiceService.createInvoice(
        { tenantId, userId },
        {
          opportunityId,
          amount,
          status,
          dueDate: dueDate ? new Date(dueDate) : undefined
        }
      );

      res.status(201).json(invoice);
    } catch (err) {
      next(err);
    }
  });

  // ─── PATCH /api/v1/invoices/:id ─────────────────────────────────────
  router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const { amount, status, dueDate } = req.body as {
        amount?: number | string;
        status?: InvoiceStatus;
        dueDate?: string;
      };

      if (status && !Object.values(InvoiceStatus).includes(status)) {
        throw new ValidationError(`status must be one of: ${Object.values(InvoiceStatus).join(', ')}`);
      }

      const invoice = await invoiceService.updateInvoice(
        { tenantId, userId },
        req.params.id,
        {
          amount,
          status,
          dueDate: dueDate ? new Date(dueDate) : undefined
        }
      );

      res.json(invoice);
    } catch (err) {
      next(err);
    }
  });

  // ─── DELETE /api/v1/invoices/:id ────────────────────────────────────
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      await invoiceService.deleteInvoice({ tenantId, userId }, req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
