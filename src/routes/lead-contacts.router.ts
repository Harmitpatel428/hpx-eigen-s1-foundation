import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';

export function createLeadContactsRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });

  // GET /api/v1/leads/:leadId/contacts
  router.get(
    '/',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { leadId } = req.params;

        const contacts = await (prisma as any).contact.findMany({
          where: { leadId, tenantId, deletedAt: null },
          orderBy: [{ isMain: 'desc' }, { createdAt: 'asc' }],
        });

        res.json({ data: contacts });
      } catch (err) { next(err); }
    }
  );

  // POST /api/v1/leads/:leadId/contacts
  router.post(
    '/',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { leadId } = req.params;
        const { firstName, lastName, email, phone, title, role, isMain } = req.body as {
          firstName: string; lastName: string; email?: string; phone?: string;
          title?: string; role?: string; isMain?: boolean;
        };

        if (!firstName || !lastName) throw new ValidationError('firstName and lastName are required.');

        const lead = await (prisma as any).lead.findFirst({ where: { id: leadId, tenantId, deletedAt: null } });
        if (!lead) throw new ResourceNotFoundError();

        await (prisma as any).$transaction(async (tx: any) => {
          if (isMain) {
            await tx.contact.updateMany({ where: { leadId, tenantId, deletedAt: null }, data: { isMain: false } });
          }
          const contact = await tx.contact.create({
            data: { tenantId, leadId, firstName, lastName, email: email ?? null, phone: phone ?? null, title: title ?? null, role: role ?? null, isMain: isMain ?? false },
          });
          return contact;
        });

        const contacts = await (prisma as any).contact.findMany({
          where: { leadId, tenantId, deletedAt: null },
          orderBy: [{ isMain: 'desc' }, { createdAt: 'asc' }],
        });

        res.status(201).json({ data: contacts });
      } catch (err) { next(err); }
    }
  );

  // PUT /api/v1/leads/:leadId/contacts/:contactId
  router.put(
    '/:contactId',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { leadId, contactId } = req.params;
        const { firstName, lastName, email, phone, title, role, isMain } = req.body as {
          firstName?: string; lastName?: string; email?: string; phone?: string;
          title?: string; role?: string; isMain?: boolean;
        };

        const existing = await (prisma as any).contact.findFirst({ where: { id: contactId, leadId, tenantId, deletedAt: null } });
        if (!existing) throw new ResourceNotFoundError();

        await (prisma as any).$transaction(async (tx: any) => {
          if (isMain === true) {
            await tx.contact.updateMany({ where: { leadId, tenantId, deletedAt: null, id: { not: contactId } }, data: { isMain: false } });
          }
          await tx.contact.update({
            where: { id: contactId },
            data: {
              ...(firstName !== undefined ? { firstName } : {}),
              ...(lastName !== undefined ? { lastName } : {}),
              ...(email !== undefined ? { email } : {}),
              ...(phone !== undefined ? { phone } : {}),
              ...(title !== undefined ? { title } : {}),
              ...(role !== undefined ? { role } : {}),
              ...(isMain !== undefined ? { isMain } : {}),
            },
          });
        });

        const contacts = await (prisma as any).contact.findMany({
          where: { leadId, tenantId, deletedAt: null },
          orderBy: [{ isMain: 'desc' }, { createdAt: 'asc' }],
        });

        res.json({ data: contacts });
      } catch (err) { next(err); }
    }
  );

  // DELETE /api/v1/leads/:leadId/contacts/:contactId
  router.delete(
    '/:contactId',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { leadId, contactId } = req.params;

        const existing = await (prisma as any).contact.findFirst({ where: { id: contactId, leadId, tenantId, deletedAt: null } });
        if (!existing) throw new ResourceNotFoundError();

        await (prisma as any).contact.update({ where: { id: contactId }, data: { deletedAt: new Date() } });

        // If deleted contact was main, auto-promote the next one
        if (existing.isMain) {
          const next = await (prisma as any).contact.findFirst({ where: { leadId, tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
          if (next) await (prisma as any).contact.update({ where: { id: next.id }, data: { isMain: true } });
        }

        const contacts = await (prisma as any).contact.findMany({
          where: { leadId, tenantId, deletedAt: null },
          orderBy: [{ isMain: 'desc' }, { createdAt: 'asc' }],
        });

        res.json({ data: contacts });
      } catch (err) { next(err); }
    }
  );

  return router;
}
