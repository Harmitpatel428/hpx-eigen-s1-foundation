import { PrismaClient, Invoice, InvoiceStatus, Prisma } from '@prisma/client';
import { AuditService } from './audit.service';
import { ResourceNotFoundError, ValidationError } from '../types/exceptions';

export interface UserContext {
  tenantId: string;
  userId: string;
}

export class InvoiceService {
  private auditService: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.auditService = new AuditService(prisma);
  }

  async createInvoice(
    ctx: UserContext,
    data: { opportunityId: string; amount: number | string; status?: InvoiceStatus; dueDate?: Date }
  ): Promise<Invoice> {
    const { tenantId, userId } = ctx;

    // Verify opportunity belongs to tenant
    const opportunity = await this.prisma.opportunity.findFirst({
      where: { id: data.opportunityId, tenantId, deletedAt: null }
    });

    if (!opportunity) {
      throw new ResourceNotFoundError();
    }

    const invoice = await this.prisma.invoice.create({
      data: {
        tenantId,
        opportunityId: data.opportunityId,
        amount: data.amount,
        status: data.status || InvoiceStatus.DRAFT,
        dueDate: data.dueDate
      }
    });

    await this.auditService.log({
      tenantId,
      eventType: 'INVOICE_CREATED',
      entityType: 'INVOICE',
      entityId: invoice.id,
      actorUserId: userId,
      operation: 'CREATE',
      payload: { amount: data.amount, status: invoice.status }
    });

    return invoice;
  }

  async listInvoices(
    ctx: UserContext,
    filters?: { status?: InvoiceStatus; opportunityId?: string }
  ): Promise<Invoice[]> {
    const { tenantId } = ctx;

    const where: Prisma.InvoiceWhereInput = {
      tenantId,
      deletedAt: null
    };

    if (filters?.status) where.status = filters.status;
    if (filters?.opportunityId) where.opportunityId = filters.opportunityId;

    return this.prisma.invoice.findMany({
      where,
      orderBy: { createdAt: 'desc' }
    });
  }

  async getInvoiceById(ctx: UserContext, id: string): Promise<Invoice> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
      include: { payments: { where: { deletedAt: null } } }
    });

    if (!invoice) {
      throw new ResourceNotFoundError();
    }
    return invoice;
  }

  async updateInvoice(
    ctx: UserContext,
    id: string,
    data: { amount?: number | string; status?: InvoiceStatus; dueDate?: Date }
  ): Promise<Invoice> {
    const { tenantId, userId } = ctx;

    const existing = await this.getInvoiceById(ctx, id);

    const updated = await this.prisma.invoice.update({
      where: { id },
      data: {
        amount: data.amount !== undefined ? data.amount : undefined,
        status: data.status !== undefined ? data.status : undefined,
        dueDate: data.dueDate !== undefined ? data.dueDate : undefined
      }
    });

    await this.auditService.log({
      tenantId,
      eventType: 'INVOICE_UPDATED',
      entityType: 'INVOICE',
      entityId: id,
      actorUserId: userId,
      operation: 'UPDATE',
      payload: {
        previous: { amount: existing.amount, status: existing.status },
        new: { amount: updated.amount, status: updated.status }
      }
    });

    return updated;
  }

  async deleteInvoice(ctx: UserContext, id: string): Promise<void> {
    const { tenantId, userId } = ctx;
    await this.getInvoiceById(ctx, id); // validates ownership and existence

    await this.prisma.invoice.update({
      where: { id },
      data: { deletedAt: new Date() }
    });

    await this.auditService.log({
      tenantId,
      eventType: 'INVOICE_DELETED',
      entityType: 'INVOICE',
      entityId: id,
      actorUserId: userId,
      operation: 'DELETE',
      payload: {}
    });
  }
}
