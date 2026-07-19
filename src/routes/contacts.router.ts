import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ContactService } from '../services/contact.service';
import { ValidationError } from '../types/exceptions';

export function createContactsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const contactService = new ContactService(prisma);

  // ─── POST /api/contacts ───────────────────────────────────────────
  /** Create a new contact */
  router.post('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const { firstName, lastName, email, phone, title, company, leadId } = req.body as {
        firstName: string;
        lastName: string;
        email?: string;
        phone?: string;
        title?: string;
        company?: string;
        leadId?: string;
      };

      if (!firstName || !lastName) {
        throw new ValidationError('firstName and lastName are required.');
      }

      const contact = await contactService.createContact(
        { tenantId, userId },
        { firstName, lastName, email, phone, title, company, leadId }
      );

      res.status(201).json(contact);
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/contacts ────────────────────────────────────────────
  /** List all contacts in the tenant */
  router.get('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const leadId = req.query.leadId as string | undefined;

      const contacts = leadId
        ? await contactService.listContactsByLead({ tenantId, userId }, leadId)
        : await contactService.listContacts({ tenantId, userId });

      res.json({ contacts, total: contacts.length });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /api/contacts/:id ────────────────────────────────────────
  /** Get a single contact by ID */
  router.get('/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const contact = await contactService.getContactById({ tenantId, userId }, req.params.id);
      res.json(contact);
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT /api/contacts/:id ────────────────────────────────────────
  /** Update contact fields */
  router.put('/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      const { firstName, lastName, email, phone, title, company, leadId } = req.body as {
        firstName?: string;
        lastName?: string;
        email?: string;
        phone?: string;
        title?: string;
        company?: string;
        leadId?: string;
      };

      const contact = await contactService.updateContact(
        { tenantId, userId },
        req.params.id,
        { firstName, lastName, email, phone, title, company, leadId }
      );

      res.json(contact);
    } catch (err) {
      next(err);
    }
  });

  // ─── DELETE /api/contacts/:id ─────────────────────────────────────
  /** Soft-delete a contact */
  router.delete('/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = (req as AuthenticatedRequest).user;
      await contactService.deleteContact({ tenantId, userId }, req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
