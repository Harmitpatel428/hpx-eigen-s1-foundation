import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';

const VALID_TYPES = ['INDIVIDUAL_NUMBER', 'GROUP', 'USERNAME', 'BUSINESS_ACCOUNT'] as const;
type ChannelType = typeof VALID_TYPES[number];

export function createLeadWaChannelsRouter(prisma: PrismaClient): Router {
  const router = Router({ mergeParams: true });

  // GET /api/v1/leads/:leadId/wa-channels
  router.get(
    '/',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { leadId } = req.params;

        // verify lead belongs to tenant
        const lead = await (prisma as any).lead.findFirst({
          where: { id: leadId, tenantId, deletedAt: null },
          select: { id: true },
        });
        if (!lead) throw new ResourceNotFoundError();

        const assignments = await (prisma as any).leadWhatsAppChannel.findMany({
          where: { leadId },
          include: { channel: true },
          orderBy: [{ isPrimary: 'desc' }, { channel: { createdAt: 'asc' } }],
        });

        const data = assignments
          .filter((a: any) => a.channel.status !== 'ARCHIVED')
          .map((a: any) => ({
            id: a.channel.id,
            channelType: a.channel.channelType,
            identifier: a.channel.identifier,
            displayName: a.channel.displayName,
            status: a.channel.status,
            metadata: a.channel.metadata,
            isPrimary: a.isPrimary,
            role: a.role,
            label: a.label,
            createdAt: a.channel.createdAt,
          }));

        res.json({ data });
      } catch (err) { next(err); }
    }
  );

  // POST /api/v1/leads/:leadId/wa-channels
  router.post(
    '/',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { leadId } = req.params;
        const { channelType, identifier, displayName, isPrimary, role, label } = req.body as {
          channelType?: ChannelType;
          identifier: string;
          displayName: string;
          isPrimary?: boolean;
          role?: string;
          label?: string;
        };

        if (!identifier?.trim()) throw new ValidationError('identifier is required.');
        if (!displayName?.trim()) throw new ValidationError('displayName is required.');
        if (channelType && !VALID_TYPES.includes(channelType)) {
          throw new ValidationError(`channelType must be one of: ${VALID_TYPES.join(', ')}`);
        }

        const lead = await (prisma as any).lead.findFirst({
          where: { id: leadId, tenantId, deletedAt: null },
          select: { id: true },
        });
        if (!lead) throw new ResourceNotFoundError();

        await (prisma as any).$transaction(async (tx: any) => {
          const channel = await tx.whatsAppChannel.create({
            data: {
              tenantId,
              channelType: channelType ?? 'INDIVIDUAL_NUMBER',
              identifier: identifier.trim(),
              displayName: displayName.trim(),
            },
          });

          if (isPrimary) {
            // unset existing primary for this lead
            await tx.leadWhatsAppChannel.updateMany({
              where: { leadId },
              data: { isPrimary: false },
            });
          }

          await tx.leadWhatsAppChannel.create({
            data: {
              leadId,
              channelId: channel.id,
              isPrimary: isPrimary ?? false,
              role: role ?? 'primary',
              label: label ?? null,
            },
          });
        });

        // return updated list
        const assignments = await (prisma as any).leadWhatsAppChannel.findMany({
          where: { leadId },
          include: { channel: true },
          orderBy: [{ isPrimary: 'desc' }, { channel: { createdAt: 'asc' } }],
        });

        res.status(201).json({
          data: assignments
            .filter((a: any) => a.channel.status !== 'ARCHIVED')
            .map((a: any) => ({
              id: a.channel.id,
              channelType: a.channel.channelType,
              identifier: a.channel.identifier,
              displayName: a.channel.displayName,
              status: a.channel.status,
              metadata: a.channel.metadata,
              isPrimary: a.isPrimary,
              role: a.role,
              label: a.label,
              createdAt: a.channel.createdAt,
            })),
        });
      } catch (err) { next(err); }
    }
  );

  // PATCH /api/v1/leads/:leadId/wa-channels/:channelId
  router.patch(
    '/:channelId',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { leadId, channelId } = req.params;
        const { displayName, label, isPrimary, role, status } = req.body as {
          displayName?: string;
          label?: string | null;
          isPrimary?: boolean;
          role?: string;
          status?: 'ACTIVE' | 'INVALID' | 'ARCHIVED';
        };

        const assignment = await (prisma as any).leadWhatsAppChannel.findFirst({
          where: { leadId, channelId },
          include: { channel: { select: { tenantId: true } } },
        });
        if (!assignment || assignment.channel.tenantId !== tenantId) throw new ResourceNotFoundError();

        if (status && !['ACTIVE', 'INVALID', 'ARCHIVED'].includes(status)) {
          throw new ValidationError('status must be ACTIVE, INVALID, or ARCHIVED.');
        }

        await (prisma as any).$transaction(async (tx: any) => {
          if (displayName !== undefined || status !== undefined) {
            await tx.whatsAppChannel.update({
              where: { id: channelId },
              data: {
                ...(displayName !== undefined ? { displayName: displayName.trim() } : {}),
                ...(status !== undefined ? { status } : {}),
              },
            });
          }

          if (isPrimary === true) {
            await tx.leadWhatsAppChannel.updateMany({
              where: { leadId, channelId: { not: channelId } },
              data: { isPrimary: false },
            });
          }

          await tx.leadWhatsAppChannel.update({
            where: { leadId_channelId: { leadId, channelId } },
            data: {
              ...(isPrimary !== undefined ? { isPrimary } : {}),
              ...(role !== undefined ? { role } : {}),
              ...(label !== undefined ? { label } : {}),
            },
          });
        });

        const assignments = await (prisma as any).leadWhatsAppChannel.findMany({
          where: { leadId },
          include: { channel: true },
          orderBy: [{ isPrimary: 'desc' }, { channel: { createdAt: 'asc' } }],
        });

        res.json({
          data: assignments
            .filter((a: any) => a.channel.status !== 'ARCHIVED')
            .map((a: any) => ({
              id: a.channel.id,
              channelType: a.channel.channelType,
              identifier: a.channel.identifier,
              displayName: a.channel.displayName,
              status: a.channel.status,
              metadata: a.channel.metadata,
              isPrimary: a.isPrimary,
              role: a.role,
              label: a.label,
              createdAt: a.channel.createdAt,
            })),
        });
      } catch (err) { next(err); }
    }
  );

  // DELETE /api/v1/leads/:leadId/wa-channels/:channelId  (archives the channel)
  router.delete(
    '/:channelId',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { leadId, channelId } = req.params;

        const assignment = await (prisma as any).leadWhatsAppChannel.findFirst({
          where: { leadId, channelId },
          include: { channel: { select: { tenantId: true, status: true } } },
        });
        if (!assignment || assignment.channel.tenantId !== tenantId) throw new ResourceNotFoundError();

        await (prisma as any).$transaction(async (tx: any) => {
          await tx.whatsAppChannel.update({
            where: { id: channelId },
            data: { status: 'ARCHIVED' },
          });

          // If archived channel was primary, auto-promote the next active channel
          if (assignment.isPrimary) {
            const next = await tx.leadWhatsAppChannel.findFirst({
              where: { leadId, channelId: { not: channelId }, channel: { status: 'ACTIVE' } },
              orderBy: { channel: { createdAt: 'asc' } },
            });
            if (next) {
              await tx.leadWhatsAppChannel.update({
                where: { leadId_channelId: { leadId, channelId: next.channelId } },
                data: { isPrimary: true },
              });
            }
          }
        });

        const assignments = await (prisma as any).leadWhatsAppChannel.findMany({
          where: { leadId },
          include: { channel: true },
          orderBy: [{ isPrimary: 'desc' }, { channel: { createdAt: 'asc' } }],
        });

        res.json({
          data: assignments
            .filter((a: any) => a.channel.status !== 'ARCHIVED')
            .map((a: any) => ({
              id: a.channel.id,
              channelType: a.channel.channelType,
              identifier: a.channel.identifier,
              displayName: a.channel.displayName,
              status: a.channel.status,
              metadata: a.channel.metadata,
              isPrimary: a.isPrimary,
              role: a.role,
              label: a.label,
              createdAt: a.channel.createdAt,
            })),
        });
      } catch (err) { next(err); }
    }
  );

  // POST /api/v1/leads/:leadId/wa-channels/:channelId/make-primary
  router.post(
    '/:channelId/make-primary',
    authMiddleware,
    permissionMiddleware('lead:edit'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { leadId, channelId } = req.params;

        const assignment = await (prisma as any).leadWhatsAppChannel.findFirst({
          where: { leadId, channelId },
          include: { channel: { select: { tenantId: true, status: true } } },
        });
        if (!assignment || assignment.channel.tenantId !== tenantId) throw new ResourceNotFoundError();
        if (assignment.channel.status === 'ARCHIVED') throw new ValidationError('Cannot set an archived channel as primary.');

        await (prisma as any).$transaction(async (tx: any) => {
          await tx.leadWhatsAppChannel.updateMany({
            where: { leadId },
            data: { isPrimary: false },
          });
          await tx.leadWhatsAppChannel.update({
            where: { leadId_channelId: { leadId, channelId } },
            data: { isPrimary: true },
          });
        });

        const assignments = await (prisma as any).leadWhatsAppChannel.findMany({
          where: { leadId },
          include: { channel: true },
          orderBy: [{ isPrimary: 'desc' }, { channel: { createdAt: 'asc' } }],
        });

        res.json({
          data: assignments
            .filter((a: any) => a.channel.status !== 'ARCHIVED')
            .map((a: any) => ({
              id: a.channel.id,
              channelType: a.channel.channelType,
              identifier: a.channel.identifier,
              displayName: a.channel.displayName,
              status: a.channel.status,
              metadata: a.channel.metadata,
              isPrimary: a.isPrimary,
              role: a.role,
              label: a.label,
              createdAt: a.channel.createdAt,
            })),
        });
      } catch (err) { next(err); }
    }
  );

  return router;
}

// ── Channel resolver ─────────────────────────────────────────────────────────
// Returns the best WhatsApp destination for a lead: explicit primary → first active → null.
// Used by the WA send flow in Phase C/D.
export async function resolveLeadWhatsAppChannel(
  prisma: PrismaClient,
  leadId: string,
  tenantId: string,
): Promise<{ id: string; channelType: string; identifier: string; displayName: string } | null> {
  const assignment = await (prisma as any).leadWhatsAppChannel.findFirst({
    where: {
      leadId,
      channel: { tenantId, status: 'ACTIVE' },
    },
    include: { channel: true },
    orderBy: [{ isPrimary: 'desc' }, { channel: { createdAt: 'asc' } }],
  });

  if (!assignment) return null;

  return {
    id: assignment.channel.id,
    channelType: assignment.channel.channelType,
    identifier: assignment.channel.identifier,
    displayName: assignment.channel.displayName,
  };
}
