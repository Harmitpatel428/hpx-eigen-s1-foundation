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
      const user = (req as AuthenticatedRequest).user;
      if (!user || !user.tenantId) {
        res.status(401).json({ message: 'Tenant ID missing from token' });
        return;
      }
      const { userId, tenantId } = user;
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
    } catch (err: any) {
      console.error('Error fetching invoices:', err);
      res.status(500).json({ message: 'Internal Server Error', error: err.message });
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
      const user = (req as AuthenticatedRequest).user;
      if (!user || !user.tenantId) {
        res.status(401).json({ message: 'Tenant ID missing from token' });
        return;
      }
      const { userId, tenantId } = user;
      const {
        opportunityId, invoiceNumber, invoiceDate, amount, taxPercentage, discount, otherCharges,
        paymentTerms, internalNotes, invoiceNotes, termsConditions, attachments, status, dueDate
      } = req.body;

      if (!opportunityId || amount === undefined) {
        throw new ValidationError('opportunityId and amount are required.');
      }

      const isUUID = (str: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
      if (!isUUID(opportunityId)) {
        throw new ValidationError('opportunityId must be a valid UUID.');
      }

      const numericAmount = typeof amount === 'string' ? parseFloat(amount.replace(/,/g, '')) : amount;
      if (isNaN(numericAmount)) {
        throw new ValidationError('Amount must be a valid number.');
      }
      
      const parsedDueDate = dueDate ? new Date(dueDate) : undefined;
      if (parsedDueDate && isNaN(parsedDueDate.getTime())) {
        throw new ValidationError('Invalid dueDate format.');
      }

      const invoice = await invoiceService.createInvoice(
        { tenantId, userId },
        {
          opportunityId,
          invoiceNumber,
          invoiceDate: invoiceDate ? new Date(invoiceDate) : undefined,
          amount: numericAmount,
          taxPercentage,
          discount,
          otherCharges,
          paymentTerms,
          internalNotes,
          invoiceNotes,
          termsConditions,
          attachments,
          status,
          dueDate: parsedDueDate
        }
      );

      res.status(201).json(invoice);
    } catch (err: any) {
      console.error('Error creating invoice:', err);
      res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
  });

  // ─── PATCH /api/v1/invoices/:id ─────────────────────────────────────
  router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const {
        invoiceNumber, invoiceDate, amount, taxPercentage, discount, otherCharges,
        paymentTerms, internalNotes, invoiceNotes, termsConditions, attachments, status, dueDate
      } = req.body;

      if (status && !Object.values(InvoiceStatus).includes(status)) {
        throw new ValidationError(`status must be one of: ${Object.values(InvoiceStatus).join(', ')}`);
      }

      const invoice = await invoiceService.updateInvoice(
        { tenantId, userId },
        req.params.id,
        {
          invoiceNumber,
          invoiceDate: invoiceDate ? new Date(invoiceDate) : undefined,
          amount,
          taxPercentage,
          discount,
          otherCharges,
          paymentTerms,
          internalNotes,
          invoiceNotes,
          termsConditions,
          attachments,
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
