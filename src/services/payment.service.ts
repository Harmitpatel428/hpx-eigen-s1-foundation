import { PrismaClient, Payment, PaymentMethod, Prisma } from '@prisma/client';
import { AuditService } from './audit.service';
import { ResourceNotFoundError } from '../types/exceptions';
import { UserContext } from './invoice.service';

export class PaymentService {
  private auditService: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.auditService = new AuditService(prisma);
  }

  async createPayment(
    ctx: UserContext,
    data: { invoiceId: string; amount: number | string; method?: PaymentMethod; paidAt?: Date }
  ): Promise<Payment> {
    const { tenantId, userId } = ctx;

    // Verify invoice belongs to tenant
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: data.invoiceId, tenantId, deletedAt: null }
    });

    if (!invoice) {
      throw new ResourceNotFoundError();
    }

    const payment = await this.prisma.payment.create({
      data: {
        tenantId,
        invoiceId: data.invoiceId,
        amount: data.amount,
        method: data.method || PaymentMethod.OTHER,
        paidAt: data.paidAt || new Date()
      }
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
