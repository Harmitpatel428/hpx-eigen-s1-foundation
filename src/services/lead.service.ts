import { PrismaClient, Prisma, LeadStatus, LeadSource, LeadStage, OpportunityCurrency } from '@prisma/client';
import { AuditService } from './audit.service';
import { ValidationError, BusinessRuleViolationError, AppException, RetryTag, ResourceNotFoundError } from '../types/exceptions';
import { AuthorizationDecision } from '../types/authorization';

export interface TenantContext {
  tenantId: string;
  userId: string;
}

export interface ConvertLeadInput {
  contact: {
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    title?: string;
    company?: string;
  };
  opportunity: {
    title: string;
    value: number | string;
    currency?: OpportunityCurrency;
    expectedCloseDate?: Date;
  };
}

export interface CreateLeadInput {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  company?: string;
  source?: LeadSource;
  notes?: string;
  ownerId?: string;
  score?: number;
  stage?: LeadStage;
  expectedValue?: number | string;
}

export interface UpdateLeadInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  company?: string;
  source?: LeadSource;
  notes?: string;
  ownerId?: string;
  status?: LeadStatus;
  score?: number;
  stage?: LeadStage;
  expectedValue?: number | string;
}

export interface FindAllLeadsOptions {
  status?: LeadStatus;
  ownerId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface PaginatedLeads {
  data: any[];
  total: number;
  page: number;
  pageSize: number;
}

export class LeadService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  /** Create a new lead */
  async createLead(ctx: TenantContext, input: CreateLeadInput) {
    if (!input.firstName?.trim() || !input.lastName?.trim()) {
      throw new ValidationError('firstName and lastName are required.');
    }

    const lead = await this.prisma.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          tenantId: ctx.tenantId,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email ?? null,
          phone: input.phone ?? null,
          company: input.company ?? null,
          source: input.source ?? LeadSource.OTHER,
          status: LeadStatus.NEW,
          stage: input.stage ?? LeadStage.NEW,
          score: input.score ?? 0,
          expectedValue: input.expectedValue !== undefined
            ? new Prisma.Decimal(input.expectedValue)
            : new Prisma.Decimal(0),
          notes: input.notes ?? null,
          ownerId: input.ownerId ?? null
        }
      });

      const txAudit = new AuditService(tx as any);
      await txAudit.log({
        tenantId: ctx.tenantId,
        eventType: 'LEAD_CREATED',
        entityType: 'Lead',
        entityId: created.id,
        actorUserId: ctx.userId,
        operation: 'CREATE',
        payload: { firstName: input.firstName, lastName: input.lastName, source: input.source },
        beforeState: null,
        afterState: created as unknown as Record<string, unknown>
      });

      return created;
    });

    return lead;
  }

  /** Get a single lead by ID */
  async getLeadById(ctx: TenantContext, leadId: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId }
    });
    if (!lead) throw new ResourceNotFoundError();
    return lead;
  }

  /** List leads with optional filters, search, and pagination */
  async listLeads(ctx: TenantContext, decision: AuthorizationDecision | undefined, options?: FindAllLeadsOptions): Promise<PaginatedLeads> {
    if (decision && !decision.allowed) throw new AppException('AUTHORIZATION_ERROR', 'Permission denied.', RetryTag.NON_RETRYABLE, 403);
    
    const page = options?.page ?? 1;
    const pageSize = options?.pageSize ?? 50;
    const skip = (page - 1) * pageSize;

    const searchWhere: Prisma.LeadWhereInput[] | undefined = options?.search
      ? [
          { firstName: { contains: options.search, mode: 'insensitive' } },
          { lastName: { contains: options.search, mode: 'insensitive' } },
          { company: { contains: options.search, mode: 'insensitive' } },
          { email: { contains: options.search, mode: 'insensitive' } }
        ]
      : undefined;

    const where: Prisma.LeadWhereInput = {
      ...(options?.status ? { status: options.status } : {}),
      ...(options?.ownerId ? { ownerId: options.ownerId } : {}),
      ...(searchWhere ? { OR: searchWhere } : {})
    };

    const [data, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize
      }),
      this.prisma.lead.count({ where })
    ]);

    return { data, total, page, pageSize };
  }

  /** List leads by status */
  async listLeadsByStatus(ctx: TenantContext, status: LeadStatus) {
    return this.prisma.lead.findMany({
      where: { status },
      orderBy: { createdAt: 'desc' }
    });
  }

  async updateLead(ctx: TenantContext, decision: AuthorizationDecision | undefined, leadId: string, input: UpdateLeadInput) {
    if (decision && !decision.allowed) throw new AppException('AUTHORIZATION_ERROR', 'Permission denied.', RetryTag.NON_RETRYABLE, 403);
    
    const beforeLead = await this.getLeadById(ctx, leadId);

    const lead = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({
        where: { id: leadId },
        data: {
          ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.company !== undefined ? { company: input.company } : {}),
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.stage !== undefined ? { stage: input.stage } : {}),
          ...(input.score !== undefined ? { score: input.score } : {}),
          ...(input.expectedValue !== undefined
            ? { expectedValue: new Prisma.Decimal(input.expectedValue) }
            : {})
        }
      });
      
      const txAudit = new AuditService(tx as any);
      await txAudit.log({
        tenantId: ctx.tenantId,
        eventType: 'LEAD_UPDATED',
        entityType: 'Lead',
        entityId: leadId,
        actorUserId: ctx.userId,
        operation: 'UPDATE',
        payload: { changes: input },
        beforeState: beforeLead as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>
      });

      return updated;
    });

    return lead;
  }

  /**
   * Convert a lead to a Contact + Opportunity in a single transaction.
   * Sets lead status = CONVERTED and creates a Pipeline entry for the opportunity.
   */
  async convertLead(ctx: TenantContext, leadId: string, input: ConvertLeadInput) {
    const lead = await this.getLeadById(ctx, leadId);
    if (lead.status === LeadStatus.CONVERTED) {
      throw new BusinessRuleViolationError();
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const contact = await tx.contact.create({
        data: {
          tenantId: ctx.tenantId,
          leadId,
          firstName: input.contact.firstName,
          lastName: input.contact.lastName,
          email: input.contact.email ?? null,
          phone: input.contact.phone ?? null,
          title: input.contact.title ?? null,
          company: input.contact.company ?? lead.company ?? null
        }
      });

      const opportunity = await tx.opportunity.create({
        data: {
          tenantId: ctx.tenantId,
          leadId,
          contactId: contact.id,
          ownerId: lead.ownerId ?? ctx.userId,
          title: input.opportunity.title,
          value: input.opportunity.value,
          currency: input.opportunity.currency ?? OpportunityCurrency.INR,
          expectedCloseDate: input.opportunity.expectedCloseDate ?? null
        }
      });

      await tx.pipeline.create({
        data: {
          tenantId: ctx.tenantId,
          opportunityId: opportunity.id,
          stage: opportunity.stage,
          enteredAt: new Date()
        }
      });

      await tx.lead.update({
        where: { id: leadId },
        data: { status: LeadStatus.CONVERTED }
      });

      return { contact, opportunity };
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'LEAD_CONVERTED',
      entityType: 'Lead',
      entityId: leadId,
      actorUserId: ctx.userId,
      operation: 'UPDATE',
      payload: {
        contactId: result.contact.id,
        opportunityId: result.opportunity.id,
        opportunityTitle: input.opportunity.title
      }
    });

    return result;
  }

  /** Soft-delete a lead */
  async deleteLead(ctx: TenantContext, leadId: string) {
    const lead = await this.getLeadById(ctx, leadId);
    
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { deletedAt: new Date() }
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'LEAD_DELETED',
      entityType: 'Lead',
      entityId: leadId,
      actorUserId: ctx.userId,
      operation: 'DELETE',
      payload: {}
    });
  }
}
