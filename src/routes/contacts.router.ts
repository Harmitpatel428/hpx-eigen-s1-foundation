import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ContactService } from '../services/contact.service';
import { ValidationError } from '../types/exceptions';
import { buildOwnerFilter, ScopeType } from '../utils/scope.helper';

export function createContactsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const contactService = new ContactService(prisma);

  // ─── POST /api/v1/contacts ────────────────────────────────────────
  /** Create a new contact — requires contact:create */
  router.post(
    '/',
    authMiddleware,
    permissionMiddleware('contact:create'),
    async (req: Request, res: Response, next: NextFunction) => {
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
    }
  );

  // ─── GET /api/v1/contacts ─────────────────────────────────────────
  /**
   * List contacts with dynamic ABAC scope filtering.
   * Contacts are scoped by ownerId (assigned during creation from leadId chain).
   */
  router.get(
    '/',
    authMiddleware,
    permissionMiddleware('contact:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          userId,
          tenantId,
          teamId,
          departmentId,
          scope,
        } = (req as AuthenticatedRequest).user;

        const leadId = req.query.leadId as string | undefined;
        const search = req.query.search as string | undefined;
        const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
        const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 50;

        const ownerFilter = await buildOwnerFilter(
          (scope ?? 'OWN') as ScopeType,
          userId,
          teamId,
          departmentId,
          prisma
        );

        const whereClause: Prisma.ContactWhereInput = {
          tenantId,
          deletedAt: null,
          ...ownerFilter,
        };

        if (leadId) whereClause.leadId = leadId;
        if (search) {
          whereClause.OR = [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { company: { contains: search, mode: 'insensitive' } },
          ];
        }

        const skip = (page - 1) * pageSize;
        const [data, total] = await Promise.all([
          prisma.contact.findMany({ where: whereClause, skip, take: pageSize, orderBy: { createdAt: 'desc' } }),
          prisma.contact.count({ where: whereClause }),
        ]);

        res.json({ data, total, page, pageSize });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /api/v1/contacts/:id ─────────────────────────────────────
  /** Get a single contact by ID — requires contact:view */
  router.get(
    '/:id',
    authMiddleware,
    permissionMiddleware('contact:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        const contact = await contactService.getContactById({ tenantId, userId }, req.params.id);
        res.json(contact);
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── PUT /api/v1/contacts/:id ─────────────────────────────────────
  /** Update contact fields — requires contact:edit */
  router.put(
    '/:id',
    authMiddleware,
    permissionMiddleware('contact:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
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
    }
  );

  // ─── DELETE /api/v1/contacts/:id ──────────────────────────────────
  /** Soft-delete a contact — requires contact:delete */
  router.delete(
    '/:id',
    authMiddleware,
    permissionMiddleware('contact:delete'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, tenantId } = (req as AuthenticatedRequest).user;
        await contactService.deleteContact({ tenantId, userId }, req.params.id);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
