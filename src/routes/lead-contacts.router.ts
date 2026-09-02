import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';
import { PhoneService } from '../services/phone.service';

export function createLeadContactsRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });
  const phoneService = new PhoneService(prisma);

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
          if (phone) {
            await phoneService.attach(tx, leadId, tenantId, phone, { isPrimary: isMain ?? false, source: 'MANUAL' });
            if (isMain) await phoneService.syncLeadPhone(tx, leadId);
          }
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
        const { firstName, lastName, email, phone, title, role, isMain, company } = req.body as {
          firstName?: string; lastName?: string; email?: string; phone?: string;
          title?: string; role?: string; isMain?: boolean; company?: string;
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
              ...(company !== undefined ? { company } : {}),
              ...(isMain !== undefined ? { isMain } : {}),
            },
          });
          if (phone !== undefined && existing.phone !== phone) {
            if (existing.phone) await phoneService.deactivate(tx, leadId, existing.phone);
            if (phone) await phoneService.attach(tx, leadId, tenantId, phone, { isPrimary: isMain === true, source: 'MANUAL' });
          }
          // R4: setMain → contact's phone becomes lead primary
          if (isMain === true) {
            const effectivePhone = phone !== undefined ? phone : existing.phone;
            if (effectivePhone) {
              await phoneService.setPrimary(tx, leadId, effectivePhone);
              await phoneService.syncLeadPhone(tx, leadId);
            }
          }

          // B1: setMain → copy PERSON_FIELDS (minus phone) to Lead row
          if (isMain === true) {
            const newMain = await tx.contact.findFirst({
              where: { id: contactId },
              select: { firstName: true, lastName: true, email: true, company: true },
            });
            if (newMain) {
              await tx.lead.update({ where: { id: leadId }, data: {
                firstName: newMain.firstName, lastName: newMain.lastName,
                email: newMain.email, company: newMain.company,
              }});
            }
          }

          // B3: Reverse sync — main contact edits propagate to lead fields (minus phone)
          const isMainAfterUpdate = isMain ?? existing.isMain;
          if (isMainAfterUpdate && isMain !== true) {
            const syncData: Record<string, string | null | undefined> = {};
            if (firstName !== undefined) syncData.firstName = firstName;
            if (lastName !== undefined) syncData.lastName = lastName;
            if (email !== undefined) syncData.email = email;
            if (company !== undefined) syncData.company = company;
            if (Object.keys(syncData).length > 0) {
              await tx.lead.update({ where: { id: leadId }, data: syncData });
            }
          }
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

        // Deactivate phone in history (keeps record)
        if (existing.phone) {
          await phoneService.deactivate(prisma as any, leadId, existing.phone);
        }

        // B4: If deleted contact was main, auto-promote and resync lead cache
        if (existing.isMain) {
          const next = await (prisma as any).contact.findFirst({ where: { leadId, tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
          if (next) {
            await (prisma as any).contact.update({ where: { id: next.id }, data: { isMain: true } });
            // Copy promoted contact's fields to Lead (minus phone)
            await (prisma as any).lead.update({ where: { id: leadId }, data: {
              firstName: next.firstName, lastName: next.lastName,
              email: next.email, company: next.company,
            }});
            if (next.phone) {
              await phoneService.setPrimary(prisma, leadId, next.phone);
              await phoneService.syncLeadPhone(prisma, leadId);
            }
          }
          // if next is null: leave Lead fields unchanged (no null-wipe)
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
