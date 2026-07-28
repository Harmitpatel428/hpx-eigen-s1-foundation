import { z } from 'zod';
import { PaymentMethod, PaymentStatus } from '@prisma/client';

/**
 * Zod refine helper — converts to Prisma-safe Decimal string.
 * Rejects NaN, Infinity, and negative values.
 */
const positiveDecimalString = z
  .union([z.string(), z.number()])
  .transform((val) => {
    const cleaned = typeof val === 'string' ? val.replace(/,/g, '') : String(val);
    const n = parseFloat(cleaned);
    if (isNaN(n) || !isFinite(n)) {
      throw new Error('Must be a valid number');
    }
    if (n <= 0) {
      throw new Error('Must be greater than zero');
    }
    // Return as fixed-precision string — safe for Prisma Decimal constructor
    return cleaned;
  });

const isoDateString = z
  .string()
  .datetime({ offset: true, message: 'Must be a valid ISO 8601 date string' })
  .optional();

// ─── Create Payment ───────────────────────────────────────────────────────────
export const createPaymentSchema = z.object({
  body: z.object({
    invoiceId: z.string().uuid('invoiceId must be a valid UUID'),
    amount: positiveDecimalString,
    method: z.nativeEnum(PaymentMethod).optional(),
    referenceNumber: z.string().max(100).optional(),
    bankName: z.string().max(100).optional(),
    chequeNumber: z.string().max(50).optional(),
    status: z.nativeEnum(PaymentStatus).optional(),
    receivedBy: z.string().max(100).optional(),
    notes: z.string().max(1000).optional(),
    attachmentUrl: z.string().url('attachmentUrl must be a valid URL').optional().or(z.literal('')),
    paidAt: isoDateString,
  }),
});

// ─── Update Payment ───────────────────────────────────────────────────────────
export const updatePaymentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Payment ID must be a valid UUID'),
  }),
  body: z
    .object({
      amount: positiveDecimalString.optional(),
      method: z.nativeEnum(PaymentMethod).optional(),
      referenceNumber: z.string().max(100).optional(),
      bankName: z.string().max(100).optional(),
      chequeNumber: z.string().max(50).optional(),
      status: z.nativeEnum(PaymentStatus).optional(),
      receivedBy: z.string().max(100).optional(),
      notes: z.string().max(1000).optional(),
      attachmentUrl: z.string().url('attachmentUrl must be a valid URL').optional().or(z.literal('')),
      paidAt: isoDateString,
    })
    .refine((b) => Object.keys(b).length > 0, {
      message: 'At least one field must be provided for update',
    }),
});

// ─── List Payments ────────────────────────────────────────────────────────────
export const listPaymentsSchema = z.object({
  query: z.object({
    method: z.nativeEnum(PaymentMethod).optional(),
    invoiceId: z.string().uuid('invoiceId must be a valid UUID').optional(),
  }),
});

// ─── Delete / Get by ID ───────────────────────────────────────────────────────
export const paymentIdSchema = z.object({
  params: z.object({
    id: z.string().uuid('Payment ID must be a valid UUID'),
  }),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>['body'];
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>['body'];
