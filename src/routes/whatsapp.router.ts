import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';
import { resolveLeadWhatsAppChannel } from './lead-wa-channels.router';
import { defaultAdapter } from '../adapters/whatsapp/whatsapp.adapter';

// ── Webhook HMAC verification ────────────────────────────────────────────────
// Senders must sign with WEBHOOK_SECRET:
//   x-webhook-timestamp: unix seconds
//   x-webhook-signature: hex HMAC-SHA256(`${timestamp}.${rawBody}`)
// Timestamps outside REPLAY_WINDOW_SECONDS are rejected (replay protection).
const WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: 'missing_signature' | 'stale_timestamp' | 'invalid_signature' };

export function verifyWebhookSignature(
  rawBody: Buffer | undefined,
  timestampHeader: string | string[] | undefined,
  signatureHeader: string | string[] | undefined,
  secret: string | undefined,
  nowMs: number = Date.now()
): SignatureCheck {
  if (!secret) return { ok: false, reason: 'missing_signature' };
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!rawBody?.length || !timestamp || !signature) return { ok: false, reason: 'missing_signature' };

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > WEBHOOK_REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${ts}.`), rawBody]))
    .digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  return { ok: true };
}

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
        const secret = process.env.WEBHOOK_SECRET;
        if (!secret) {
          // Fail closed — an unsigned write path into conversations must not
          // exist just because configuration is missing.
          console.error('[WA-WEBHOOK] WEBHOOK_SECRET not configured — rejecting webhook.');
          res.status(503).json({ ok: false, reason: 'webhook_not_configured' });
          return;
        }

        const check = verifyWebhookSignature(
          (req as Request & { rawBody?: Buffer }).rawBody,
          req.headers['x-webhook-timestamp'],
          req.headers['x-webhook-signature'],
          secret
        );
        if (!check.ok) {
          res.status(401).json({ ok: false, reason: check.reason });
          return;
        }

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
