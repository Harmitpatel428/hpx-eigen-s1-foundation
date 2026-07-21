import { PrismaClient, Payment, PaymentMethod, Prisma, PaymentStatus, InvoiceStatus } from '@prisma/client';
import { AuditService } from './audit.service';
import { ResourceNotFoundError } from '../types/exceptions';
import { UserContext } from './invoice.service';
import { ValidationError } from '../types/exceptions';

export interface CreatePaymentInput {
  invoiceId: string;
  amount: number | string;
  method?: PaymentMethod;
  referenceNumber?: string;
  bankName?: string;
  chequeNumber?: string;
  status?: PaymentStatus;
  receivedBy?: string;
  notes?: string;
  attachmentUrl?: string;
  paidAt?: Date;
}

export interface UpdatePaymentInput {
  amount?: number | string;
  method?: PaymentMethod;
  referenceNumber?: string;
  bankName?: string;
  chequeNumber?: string;
  status?: PaymentStatus;
  receivedBy?: string;
  notes?: string;
  attachmentUrl?: string;
  paidAt?: Date;
}

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

    // Verify invoice belongs to tenant and get payments
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: data.invoiceId, tenantId, deletedAt: null },
      include: { payments: { where: { deletedAt: null, status: { not: PaymentStatus.CANCELLED } } } }
    });

    if (!invoice) {
      throw new ResourceNotFoundError();
    }

    if (data.paidAt && data.paidAt > new Date()) {
      throw new ValidationError('Payment date cannot be in the future.');
    }

    const currentTotalPaid = invoice.payments.reduce((acc, p) => acc + p.amount.toNumber(), 0);
    const remainingBalance = invoice.totalAmount.toNumber() - currentTotalPaid;
    const paymentAmount = Number(data.amount);

    if (paymentAmount > remainingBalance + 0.01) { // 0.01 tolerance for floating point
      throw new ValidationError(`Amount received cannot exceed the remaining balance of ${remainingBalance}`);
    }

    // Determine new invoice status
    const newTotalPaid = currentTotalPaid + paymentAmount;
    let newInvoiceStatus = invoice.status;
    
    if (newTotalPaid >= invoice.totalAmount.toNumber() - 0.01) {
      newInvoiceStatus = InvoiceStatus.PAID;
    } else if (newTotalPaid > 0) {
      newInvoiceStatus = InvoiceStatus.PARTIALLY_PAID;
    }

    const payment = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          tenantId,
          invoiceId: data.invoiceId,
          amount: data.amount,
          method: data.method || PaymentMethod.CASH,
          referenceNumber: data.referenceNumber,
          bankName: data.bankName,
          chequeNumber: data.chequeNumber,
          status: data.status || PaymentStatus.PENDING,
          receivedBy: data.receivedBy,
          notes: data.notes,
          attachmentUrl: data.attachmentUrl,
          paidAt: data.paidAt || new Date()
        }
      });

      if (invoice.status !== newInvoiceStatus) {
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { status: newInvoiceStatus }
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
      payload: { amount: data.amount, method: payment.method }
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
      deletedAt: null
    };

    if (filters?.invoiceId) where.invoiceId = filters.invoiceId;
    if (filters?.method) where.method = filters.method;

    return this.prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' }
    });
  }

  async updatePayment(
    ctx: UserContext,
    id: string,
    data: UpdatePaymentInput
  ): Promise<Payment> {
    const { tenantId, userId } = ctx;

    const existing = await this.prisma.payment.findFirst({
      where: { id, tenantId, deletedAt: null }
    });

    if (!existing) {
      throw new ResourceNotFoundError();
    }

    const updated = await this.prisma.payment.update({
      where: { id },
      data: {
        amount: data.amount !== undefined ? data.amount : undefined,
        method: data.method !== undefined ? data.method : undefined,
        referenceNumber: data.referenceNumber !== undefined ? data.referenceNumber : undefined,
        bankName: data.bankName !== undefined ? data.bankName : undefined,
        chequeNumber: data.chequeNumber !== undefined ? data.chequeNumber : undefined,
        status: data.status !== undefined ? data.status : undefined,
        receivedBy: data.receivedBy !== undefined ? data.receivedBy : undefined,
        notes: data.notes !== undefined ? data.notes : undefined,
        attachmentUrl: data.attachmentUrl !== undefined ? data.attachmentUrl : undefined,
        paidAt: data.paidAt !== undefined ? data.paidAt : undefined
      }
    });

    return updated;
  }

  async getPaymentById(ctx: UserContext, id: string): Promise<Payment> {
    const payment = await this.prisma.payment.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null }
    });

    if (!payment) {
      throw new ResourceNotFoundError();
    }
    return payment;
  }

  async deletePayment(ctx: UserContext, id: string): Promise<void> {
    const { tenantId, userId } = ctx;
    await this.getPaymentById(ctx, id); // validates ownership and existence

    await this.prisma.payment.update({
      where: { id },
      data: { deletedAt: new Date() }
    });

    await this.auditService.log({
      tenantId,
      eventType: 'PAYMENT_DELETED',
      entityType: 'PAYMENT',
      entityId: id,
      actorUserId: userId,
      operation: 'DELETE',
      payload: {}
    });
  }
}
