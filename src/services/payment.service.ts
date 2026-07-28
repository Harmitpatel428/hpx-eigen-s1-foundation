import { PrismaClient, Payment, PaymentMethod, Prisma, PaymentStatus, InvoiceStatus } from '@prisma/client';
import { AuditService } from './audit.service';
import { ResourceNotFoundError, ValidationError } from '../types/exceptions';
import { UserContext } from './invoice.service';
import { CreatePaymentInput, UpdatePaymentInput } from '../schemas/payment.schema';

export class PaymentService {
  private auditService: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.auditService = new AuditService(prisma);
  }

  async createPayment(
    ctx: UserContext,
    data: CreatePaymentInput
  ): Promise<Payment> {
    const { tenantId, userId } = ctx;

    // Verify invoice belongs to tenant and fetch all active payments
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: data.invoiceId, tenantId, deletedAt: null },
      include: {
        payments: {
          where: { deletedAt: null, status: { not: PaymentStatus.CANCELLED } },
          select: { amount: true }
        }
      }
    });

    if (!invoice) throw new ResourceNotFoundError();

    if (data.paidAt && new Date(data.paidAt) > new Date()) {
      throw new ValidationError('Payment date cannot be in the future.');
    }

    // ─── DECIMAL MATH: all arithmetic via Prisma.Decimal to avoid floating-point errors ─
    const paymentAmount = new Prisma.Decimal(data.amount);
    const totalAmount = invoice.totalAmount;

    const currentTotalPaid = invoice.payments.reduce(
      (acc, p) => acc.plus(p.amount),
      new Prisma.Decimal(0)
    );

    const remainingBalance = totalAmount.minus(currentTotalPaid);

    // Use Decimal comparison — no epsilon tolerance hacks
    if (paymentAmount.greaterThan(remainingBalance)) {
      throw new ValidationError(
        `Amount received (${paymentAmount.toFixed(2)}) cannot exceed remaining balance (${remainingBalance.toFixed(2)}).`
      );
    }

    // ─── Determine new invoice status via Decimal comparisons ────────────────
    const newTotalPaid = currentTotalPaid.plus(paymentAmount);
    let newInvoiceStatus = invoice.status;

    if (newTotalPaid.greaterThanOrEqualTo(totalAmount)) {
      newInvoiceStatus = InvoiceStatus.PAID;
    } else if (newTotalPaid.greaterThan(0)) {
      newInvoiceStatus = InvoiceStatus.PARTIALLY_PAID;
    }

    // ─── Atomic transaction: create payment + conditionally update invoice ────
    const payment = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          tenantId,
          invoiceId: data.invoiceId,
          // Store as Decimal string — Prisma handles the DB mapping correctly
          amount: paymentAmount,
          method: data.method ?? PaymentMethod.CASH,
          referenceNumber: data.referenceNumber,
          bankName: data.bankName,
          chequeNumber: data.chequeNumber,
          status: data.status ?? PaymentStatus.PENDING,
          receivedBy: data.receivedBy,
          notes: data.notes,
          attachmentUrl: data.attachmentUrl,
          paidAt: data.paidAt ? new Date(data.paidAt) : new Date(),
        },
      });

      if (invoice.status !== newInvoiceStatus) {
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { status: newInvoiceStatus },
        });
      }

      return p;
    });

    await this.auditService.log({
      tenantId,
      eventType: 'PAYMENT_CREATED',
      entityType: 'PAYMENT',
      entityId: payment.id,
      actorUserId: userId,
      operation: 'CREATE',
      payload: { amount: paymentAmount.toFixed(2), method: payment.method },
    });

    return payment;
  }

  async listPayments(
    ctx: UserContext,
    filters?: { invoiceId?: string; method?: PaymentMethod }
  ): Promise<Payment[]> {
    const { tenantId } = ctx;

    const where: Prisma.PaymentWhereInput = {
      tenantId,
      deletedAt: null,
    };

    if (filters?.invoiceId) where.invoiceId = filters.invoiceId;
    if (filters?.method) where.method = filters.method;

    return this.prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async updatePayment(
    ctx: UserContext,
    id: string,
    data: UpdatePaymentInput
  ): Promise<Payment> {
    const { tenantId, userId } = ctx;

    const existing = await this.prisma.payment.findFirst({
      where: { id, tenantId, deletedAt: null },
    });

    if (!existing) throw new ResourceNotFoundError();

    // If amount is being updated, re-validate the balance constraint
    if (data.amount !== undefined) {
      const invoice = await this.prisma.invoice.findFirst({
        where: { id: existing.invoiceId, tenantId, deletedAt: null },
        include: {
          payments: {
            where: {
              deletedAt: null,
              status: { not: PaymentStatus.CANCELLED },
              id: { not: id } // Exclude the current payment from balance calculation
            },
            select: { amount: true }
          }
        }
      });

      if (!invoice) throw new ResourceNotFoundError();

      const newAmount = new Prisma.Decimal(data.amount);
      const otherPaid = invoice.payments.reduce(
        (acc, p) => acc.plus(p.amount),
        new Prisma.Decimal(0)
      );
      const newTotal = otherPaid.plus(newAmount);

      if (newTotal.greaterThan(invoice.totalAmount)) {
        const remaining = invoice.totalAmount.minus(otherPaid);
        throw new ValidationError(
          `Updated amount would exceed the invoice balance. Maximum allowed: ${remaining.toFixed(2)}.`
        );
      }
    }

    const updated = await this.prisma.payment.update({
      where: { id },
      data: {
        ...(data.amount !== undefined && { amount: new Prisma.Decimal(data.amount) }),
        ...(data.method !== undefined && { method: data.method }),
        ...(data.referenceNumber !== undefined && { referenceNumber: data.referenceNumber }),
        ...(data.bankName !== undefined && { bankName: data.bankName }),
        ...(data.chequeNumber !== undefined && { chequeNumber: data.chequeNumber }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.receivedBy !== undefined && { receivedBy: data.receivedBy }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...(data.attachmentUrl !== undefined && { attachmentUrl: data.attachmentUrl }),
        ...(data.paidAt !== undefined && { paidAt: new Date(data.paidAt) }),
      },
    });

    await this.auditService.log({
      tenantId,
      eventType: 'PAYMENT_UPDATED',
      entityType: 'PAYMENT',
      entityId: id,
      actorUserId: userId,
      operation: 'UPDATE',
      payload: { updatedFields: Object.keys(data) },
    });

    return updated;
  }

  async getPaymentById(ctx: UserContext, id: string): Promise<Payment> {
    const payment = await this.prisma.payment.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
    });

    if (!payment) throw new ResourceNotFoundError();
    return payment;
  }

  async deletePayment(ctx: UserContext, id: string): Promise<void> {
    const { tenantId, userId } = ctx;
    await this.getPaymentById(ctx, id); // validates ownership

    await this.prisma.payment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await this.auditService.log({
      tenantId,
      eventType: 'PAYMENT_DELETED',
      entityType: 'PAYMENT',
      entityId: id,
      actorUserId: userId,
      operation: 'DELETE',
      payload: {},
    });
  }
}
