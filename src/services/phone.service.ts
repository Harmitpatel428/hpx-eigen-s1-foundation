import { PrismaClient, Prisma } from '@prisma/client';
import { normalizePhone } from '../utils/phone.util';

type TxClient = Prisma.TransactionClient | PrismaClient;

export class PhoneService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Attach a phone to a lead. Idempotent: if the same normalized number
   * exists and is INACTIVE, reactivate it. If ACTIVE, update in place.
   *
   * Primary rule (R9): isPrimary = explicit true OR lead has no active primary.
   */
  async attach(
    tx: TxClient,
    leadId: string,
    tenantId: string,
    phoneOriginal: string,
    opts?: { isPrimary?: boolean; source?: 'IMPORT' | 'MANUAL' | 'API' | 'BACKFILL' },
  ) {
    const trimmed = phoneOriginal.trim();
    if (!trimmed) return null;

    const normalized = normalizePhone(trimmed);
    const source = opts?.source ?? 'MANUAL';
    let isPrimary = opts?.isPrimary ?? false;

    // R9: auto-promote to primary when lead has no active primary
    if (!isPrimary) {
      const existingPrimary = await tx.leadPhone.findFirst({
        where: { leadId, isPrimary: true, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!existingPrimary) isPrimary = true;
    }

    if (isPrimary) {
      await tx.leadPhone.updateMany({
        where: { leadId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    if (normalized) {
      const existing = await tx.leadPhone.findFirst({
        where: { leadId, phoneNormalized: normalized },
      });

      if (existing) {
        return tx.leadPhone.update({
          where: { id: existing.id },
          data: {
            status: 'ACTIVE',
            deactivatedAt: null,
            isPrimary,
            phoneOriginal: trimmed,
            source,
          },
        });
      }
    }

    return tx.leadPhone.create({
      data: {
        tenantId,
        leadId,
        phoneOriginal: trimmed,
        phoneNormalized: normalized,
        status: 'ACTIVE',
        isPrimary,
        source,
      },
    });
  }

  /**
   * Deactivate a phone (status transition, never delete). Preserves history.
   */
  async deactivate(tx: TxClient, leadId: string, phoneOriginal: string) {
    const normalized = normalizePhone(phoneOriginal);
    if (!normalized) return;

    const existing = await tx.leadPhone.findFirst({
      where: { leadId, phoneNormalized: normalized, status: 'ACTIVE' },
    });
    if (!existing) return;

    await tx.leadPhone.update({
      where: { id: existing.id },
      data: { status: 'INACTIVE', deactivatedAt: new Date(), isPrimary: false },
    });
  }

  /**
   * Flip isPrimary to a specific phone row (by contact phone string).
   * Used by setMain contact wiring.
   */
  async setPrimary(tx: TxClient, leadId: string, phoneOriginal: string) {
    const normalized = normalizePhone(phoneOriginal);
    if (!normalized) return;

    // Unset all existing primaries
    await tx.leadPhone.updateMany({
      where: { leadId, isPrimary: true },
      data: { isPrimary: false },
    });

    // Set target as primary (must be ACTIVE)
    const target = await tx.leadPhone.findFirst({
      where: { leadId, phoneNormalized: normalized, status: 'ACTIVE' },
    });
    if (target) {
      await tx.leadPhone.update({
        where: { id: target.id },
        data: { isPrimary: true },
      });
    }
  }

  /**
   * Sync lead.phone mirror column to match the current primary LeadPhone.
   */
  async syncLeadPhone(tx: TxClient, leadId: string) {
    const primary = await tx.leadPhone.findFirst({
      where: { leadId, isPrimary: true, status: 'ACTIVE' },
      select: { phoneOriginal: true },
    });

    await tx.lead.update({
      where: { id: leadId },
      data: { phone: primary?.phoneOriginal ?? null },
    });
  }

  /**
   * List all phones for a lead (history), ordered by status then createdAt.
   */
  async listByLead(leadId: string, tenantId: string) {
    return this.prisma.leadPhone.findMany({
      where: { leadId, tenantId },
      orderBy: [{ status: 'asc' }, { isPrimary: 'desc' }, { createdAt: 'desc' }],
    });
  }
}
