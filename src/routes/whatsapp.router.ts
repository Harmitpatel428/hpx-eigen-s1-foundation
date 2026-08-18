import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';
import { resolveLeadWhatsAppChannel } from './lead-wa-channels.router';
import { defaultAdapter } from '../adapters/whatsapp/whatsapp.adapter';

export function createWhatsAppRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── POST /api/v1/whatsapp/send ────────────────────────────────────────────
  // Resolves the best channel for a lead, records an outbound message, and
  // returns the deep-link URL for the client to open.
  // Body: { leadId, channelId? (override), message: { type?, body } }
  router.post(
    '/send',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { leadId, channelId: requestedChannelId, message } = req.body as {
          leadId: string;
          channelId?: string;
          message: { type?: string; body: string };
        };

        if (!leadId) throw new ValidationError('leadId is required.');
        if (!message?.body?.trim()) throw new ValidationError('message.body is required.');

        const lead = await (prisma as any).lead.findFirst({
          where: { id: leadId, tenantId, deletedAt: null },
          select: { id: true },
        });
        if (!lead) throw new ResourceNotFoundError();

        // Resolve the channel: explicit override → primary active → null
        let channel: { id: string; channelType: string; identifier: string; displayName: string } | null = null;

        if (requestedChannelId) {
          const assignment = await (prisma as any).leadWhatsAppChannel.findFirst({
            where: { leadId, channelId: requestedChannelId },
            include: { channel: { select: { id: true, channelType: true, identifier: true, displayName: true, tenantId: true, status: true } } },
          });
          if (!assignment || assignment.channel.tenantId !== tenantId || assignment.channel.status === 'ARCHIVED') {
            throw new ValidationError('Requested channel is not available for this lead.');
          }
          channel = assignment.channel;
        } else {
          channel = await resolveLeadWhatsAppChannel(prisma, leadId, tenantId);
        }

        if (!channel) throw new ValidationError('No active WhatsApp channel found for this lead.');

        if (!defaultAdapter.validateDestination(channel.identifier, channel.channelType)) {
          throw new ValidationError('Channel identifier is not a valid WhatsApp destination.');
        }

        const url = defaultAdapter.buildDeepLink(channel.identifier, channel.channelType);

        // Upsert conversation, then record the outbound message
        const conversation = await (prisma as any).$transaction(async (tx: any) => {
          const conv = await tx.conversation.upsert({
            where: { leadId_channelId: { leadId, channelId: channel!.id } },
            create: { tenantId, leadId, channelId: channel!.id },
            update: { updatedAt: new Date() },
          });

          await tx.message.create({
            data: {
              conversationId: conv.id,
              direction: 'OUTBOUND',
              type: (message.type?.toUpperCase() as any) ?? 'TEXT',
              body: message.body.trim(),
              sentAt: new Date(),
            },
          });

          return conv;
        });

        res.json({
          url,
          conversationId: conversation.id,
          channel: {
            id: channel.id,
            channelType: channel.channelType,
            identifier: channel.identifier,
            displayName: channel.displayName,
          },
        });
      } catch (err) { next(err); }
    }
  );

  // ── POST /api/v1/whatsapp/webhook ─────────────────────────────────────────
  // Receives inbound messages from the WhatsApp provider (or a proxy).
  // Expected body matches NormalizedInboundMessage shape:
  //   { externalId, from, to, type?, body, timestamp? }
  // No auth middleware — must be verified by the caller via HMAC or verify token
  // (handled at the infra/gateway layer in production).
  router.post(
    '/webhook',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // ponytail: HMAC verification skipped — add at gateway/reverse-proxy layer.
        const normalized = defaultAdapter.normalizeInboundMessage(req.body);
        if (!normalized) {
          res.status(200).json({ ok: false, reason: 'unrecognized_payload' });
          return;
        }

        // Look up the WhatsApp channel by the sender's identifier
        const channel = await (prisma as any).whatsAppChannel.findFirst({
          where: {
            identifier: normalized.fromIdentifier,
            status: 'ACTIVE',
          },
          select: { id: true, tenantId: true },
        });

        if (!channel) {
          // Unknown sender — log and acknowledge (never return non-200 to provider)
          res.status(200).json({ ok: false, reason: 'unknown_channel' });
          return;
        }

        // Find the lead associated with this channel
        const assignment = await (prisma as any).leadWhatsAppChannel.findFirst({
          where: { channelId: channel.id },
          select: { leadId: true },
        });

        if (!assignment) {
          res.status(200).json({ ok: false, reason: 'no_lead_for_channel' });
          return;
        }

        // Upsert conversation + create inbound message (idempotent on externalId)
        const existing = await (prisma as any).message.findFirst({
          where: { externalId: normalized.externalId },
          select: { id: true },
        });

        if (!existing) {
          await (prisma as any).$transaction(async (tx: any) => {
            const conv = await tx.conversation.upsert({
              where: { leadId_channelId: { leadId: assignment.leadId, channelId: channel.id } },
              create: { tenantId: channel.tenantId, leadId: assignment.leadId, channelId: channel.id },
              update: { updatedAt: new Date() },
            });

            await tx.message.create({
              data: {
                conversationId: conv.id,
                direction: 'INBOUND',
                type: normalized.type,
                body: normalized.body,
                externalId: normalized.externalId,
                sentAt: normalized.timestamp,
              },
            });
          });
        }

        res.status(200).json({ ok: true });
      } catch (err) { next(err); }
    }
  );

  // ── GET /api/v1/whatsapp/conversations/:leadId ────────────────────────────
  // Returns all conversations for a lead with recent messages.
  router.get(
    '/conversations/:leadId',
    authMiddleware,
    permissionMiddleware('lead:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = (req as AuthenticatedRequest).user;
        const { leadId } = req.params;

        const lead = await (prisma as any).lead.findFirst({
          where: { id: leadId, tenantId, deletedAt: null },
          select: { id: true },
        });
        if (!lead) throw new ResourceNotFoundError();

        const conversations = await (prisma as any).conversation.findMany({
          where: { leadId, tenantId },
          include: {
            channel: { select: { id: true, channelType: true, identifier: true, displayName: true } },
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 20,
            },
          },
          orderBy: { updatedAt: 'desc' },
        });

        res.json({ data: conversations });
      } catch (err) { next(err); }
    }
  );

  return router;
}
