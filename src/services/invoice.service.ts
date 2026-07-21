import { PrismaClient, Invoice, InvoiceStatus, Prisma } from '@prisma/client';
import { AuditService } from './audit.service';
import { ResourceNotFoundError, ValidationError } from '../types/exceptions';

export interface UserContext {
  tenantId: string;
  userId: string;
}

export interface CreateInvoiceInput {
  opportunityId: string;
  invoiceNumber?: string;
  invoiceDate?: Date;
  amount: number | string;
  taxPercentage?: number | string;
  discount?: number | string;
  otherCharges?: number | string;
  paymentTerms?: string;
  internalNotes?: string;
  invoiceNotes?: string;
  termsConditions?: string;
  attachments?: string[];
  status?: InvoiceStatus;
  dueDate?: Date;
}

export interface UpdateInvoiceInput {
  invoiceNumber?: string;
  invoiceDate?: Date;
  amount?: number | string;
  taxPercentage?: number | string;
  discount?: number | string;
  otherCharges?: number | string;
  paymentTerms?: string;
  internalNotes?: string;
  invoiceNotes?: string;
  termsConditions?: string;
  attachments?: string[];
  status?: InvoiceStatus;
  dueDate?: Date;
}

export class InvoiceService {
  private auditService: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.auditService = new AuditService(prisma);
  }

  private calculateFinancials(
    amount: number | string,
    taxPercentage: number | string = 0,
    discount: number | string = 0,
    otherCharges: number | string = 0
  ) {
    const amt = Number(amount) || 0;
    const taxP = Number(taxPercentage) || 0;
    const disc = Number(discount) || 0;
    const oth = Number(otherCharges) || 0;

    const baseAfterDiscount = amt - disc;
    const taxAmt = baseAfterDiscount > 0 ? (baseAfterDiscount * taxP) / 100 : 0;
    const total = baseAfterDiscount + taxAmt + oth;

    return {
      taxAmount: taxAmt.toFixed(2),
      totalAmount: total.toFixed(2),
    };
  }

  async createInvoice(
    ctx: UserContext,
    data: CreateInvoiceInput
  ): Promise<Invoice> {
    const { tenantId, userId } = ctx;

    // Verify opportunity belongs to tenant
    const opportunity = await this.prisma.opportunity.findFirst({
      where: { id: data.opportunityId, tenantId, deletedAt: null }
    });

    if (!opportunity) {
      throw new ResourceNotFoundError();
    }

    if (data.dueDate && data.invoiceDate && new Date(data.dueDate) < new Date(data.invoiceDate)) {
      throw new ValidationError('Due date cannot be before invoice date.');
    }

    const { taxAmount, totalAmount } = this.calculateFinancials(
      data.amount,
      data.taxPercentage,
      data.discount,
      data.otherCharges
    );

    const invoiceNumber = data.invoiceNumber || `INV-${Date.now().toString().slice(-6)}`;

    const invoice = await this.prisma.invoice.create({
      data: {
        tenantId,
        opportunityId: data.opportunityId,
        invoiceNumber,
        invoiceDate: data.invoiceDate || new Date(),
        amount: data.amount,
        taxPercentage: data.taxPercentage || 0,
        discount: data.discount || 0,
        otherCharges: data.otherCharges || 0,
        taxAmount,
        totalAmount,
        paymentTerms: data.paymentTerms,
        internalNotes: data.internalNotes,
        invoiceNotes: data.invoiceNotes,
        termsConditions: data.termsConditions,
        attachments: data.attachments || [],
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
    data: UpdateInvoiceInput
  ): Promise<Invoice> {
    const { tenantId, userId } = ctx;

    const existing = await this.getInvoiceById(ctx, id);

    const amt = data.amount !== undefined ? data.amount : existing.amount.toNumber();
    const taxP = data.taxPercentage !== undefined ? data.taxPercentage : (existing.taxPercentage?.toNumber() || 0);
    const disc = data.discount !== undefined ? data.discount : (existing.discount?.toNumber() || 0);
    const oth = data.otherCharges !== undefined ? data.otherCharges : (existing.otherCharges?.toNumber() || 0);

    const { taxAmount, totalAmount } = this.calculateFinancials(amt, taxP, disc, oth);

    const updated = await this.prisma.invoice.update({
      where: { id },
      data: {
        invoiceNumber: data.invoiceNumber !== undefined ? data.invoiceNumber : undefined,
        invoiceDate: data.invoiceDate !== undefined ? data.invoiceDate : undefined,
        amount: data.amount !== undefined ? data.amount : undefined,
        taxPercentage: data.taxPercentage !== undefined ? data.taxPercentage : undefined,
        discount: data.discount !== undefined ? data.discount : undefined,
        otherCharges: data.otherCharges !== undefined ? data.otherCharges : undefined,
        taxAmount,
        totalAmount,
        paymentTerms: data.paymentTerms !== undefined ? data.paymentTerms : undefined,
        internalNotes: data.internalNotes !== undefined ? data.internalNotes : undefined,
        invoiceNotes: data.invoiceNotes !== undefined ? data.invoiceNotes : undefined,
        termsConditions: data.termsConditions !== undefined ? data.termsConditions : undefined,
        attachments: data.attachments !== undefined ? data.attachments : undefined,
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
