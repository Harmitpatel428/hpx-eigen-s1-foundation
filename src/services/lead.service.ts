import { PrismaClient, Prisma, LeadStatus, LeadSource, LeadStage, LeadPriority, OpportunityCurrency } from '@prisma/client';
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
  priority?: LeadPriority;
  expectedCloseDate?: string | Date;
  country?: string;
  state?: string;
  city?: string;
  area?: string;
  postalCode?: string;
  freeformAddress?: string;
  customFieldValues?: Array<{ fieldId: string; value: string | null }>;
  tagNames?: string[];
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
  priority?: LeadPriority;
  expectedCloseDate?: string | Date | null;
  country?: string;
  state?: string;
  city?: string;
  area?: string;
  postalCode?: string;
  freeformAddress?: string | null;
  customFieldValues?: Array<{ fieldId: string; value: string | null }>;
  tagNames?: string[];
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

export interface DuplicateCheckInput {
  email?: string;
  phone?: string;
  company?: string;
  firstName?: string;
  lastName?: string;
  excludeId?: string;
}

export class LeadService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  /** Resolve tag names to tag IDs within a transaction, creating missing tags. */
  private async resolveTagIds(
    tx: Prisma.TransactionClient,
    tenantId: string,
    tagNames: string[]
  ): Promise<string[]> {
    if (!tagNames.length) return [];

    const tagIds: string[] = [];
    for (const name of tagNames) {
      const trimmed = name.trim();
      if (!trimmed) continue;

      const tag = await (tx as any).leadTag.upsert({
        where: { tenantId_name: { tenantId, name: trimmed } },
        create: { tenantId, name: trimmed },
        update: { usageCount: { increment: 1 } },
        select: { id: true },
      });
      tagIds.push(tag.id);
    }
    return tagIds;
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
          priority: input.priority ?? LeadPriority.MEDIUM,
          expectedCloseDate: input.expectedCloseDate
            ? new Date(input.expectedCloseDate)
            : null,
          country: input.country ?? null,
          state: input.state ?? null,
          city: input.city ?? null,
          area: input.area ?? null,
          postalCode: input.postalCode ?? null,
          freeformAddress: input.freeformAddress ?? null,
          customFieldValues: input.customFieldValues ?? [],
          notes: input.notes ?? null,
          ownerId: input.ownerId ?? null,
        } as any,
      });

      // Assign tags
      if (input.tagNames?.length) {
        const tagIds = await this.resolveTagIds(tx, ctx.tenantId, input.tagNames);
        if (tagIds.length) {
          await (tx as any).leadTagAssignment.createMany({
            data: tagIds.map((tagId) => ({ leadId: created.id, tagId })),
            skipDuplicates: true,
          });
        }
      }

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
        afterState: created as unknown as Record<string, unknown>,
      });

      return created;
    });

    return this.getLeadWithTags(ctx, lead.id);
  }

  /** Get a single lead by ID, including tags */
  async getLeadById(ctx: TenantContext, leadId: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
    });
    if (!lead) throw new ResourceNotFoundError();
    return lead;
  }

  /** Get lead with tag assignments */
  private async getLeadWithTags(ctx: TenantContext, leadId: string) {
    const lead = await (this.prisma as any).lead.findUnique({
      where: { id: leadId },
      include: {
        tags: {
          include: { tag: true },
        },
      },
    });
    if (!lead) throw new ResourceNotFoundError();
    return {
      ...lead,
      tags: (lead.tags ?? []).map((a: any) => a.tag),
    };
  }

  /** List leads with optional filters, search, and pagination */
  async listLeads(
    ctx: TenantContext,
    decision: AuthorizationDecision | undefined,
    options?: FindAllLeadsOptions
  ): Promise<PaginatedLeads> {
    if (decision && !decision.allowed)
      throw new AppException('AUTHORIZATION_ERROR', 'Permission denied.', RetryTag.NON_RETRYABLE, 403);

    const page = options?.page ?? 1;
    const pageSize = options?.pageSize ?? 50;
    const skip = (page - 1) * pageSize;

    const searchWhere: Prisma.LeadWhereInput[] | undefined = options?.search
      ? [
          { firstName: { contains: options.search, mode: Prisma.QueryMode.insensitive } },
          { lastName:  { contains: options.search, mode: Prisma.QueryMode.insensitive } },
          { company:   { contains: options.search, mode: Prisma.QueryMode.insensitive } },
          { email:     { contains: options.search, mode: Prisma.QueryMode.insensitive } },
        ]
      : undefined;

    const where: Prisma.LeadWhereInput = {
      ...(options?.status ? { status: options.status } : {}),
      ...(options?.ownerId ? { ownerId: options.ownerId } : {}),
      ...(searchWhere ? { OR: searchWhere } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.lead.count({ where }),
    ]);

    return { data, total, page, pageSize };
  }

  async updateLead(
    ctx: TenantContext,
    decision: AuthorizationDecision | undefined,
    leadId: string,
    input: UpdateLeadInput
  ) {
    if (decision && !decision.allowed)
      throw new AppException('AUTHORIZATION_ERROR', 'Permission denied.', RetryTag.NON_RETRYABLE, 403);

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
            : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...('expectedCloseDate' in input
            ? { expectedCloseDate: input.expectedCloseDate ? new Date(input.expectedCloseDate) : null }
            : {}),
          ...(input.country !== undefined ? { country: input.country } : {}),
          ...(input.state !== undefined ? { state: input.state } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.area !== undefined ? { area: input.area } : {}),
          ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
          ...(input.freeformAddress !== undefined ? { freeformAddress: input.freeformAddress } : {}),
          ...(input.customFieldValues !== undefined ? { customFieldValues: input.customFieldValues } : {}),
        } as any,
      });

      // Replace tag assignments if tagNames provided
      if (Array.isArray(input.tagNames)) {
        await (tx as any).leadTagAssignment.deleteMany({ where: { leadId } });
        if (input.tagNames.length) {
          const tagIds = await this.resolveTagIds(tx, ctx.tenantId, input.tagNames);
          if (tagIds.length) {
            await (tx as any).leadTagAssignment.createMany({
              data: tagIds.map((tagId) => ({ leadId, tagId })),
              skipDuplicates: true,
            });
          }
        }
      }

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
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated;
    });

    return this.getLeadWithTags(ctx, lead.id);
  }

  /**
   * Check for potential duplicate leads.
   * Returns leads that match on email, phone, or company+name combination.
   * Does NOT block creation — purely informational.
   */
  async checkDuplicates(ctx: TenantContext, input: DuplicateCheckInput): Promise<any[]> {
    const conditions: Prisma.LeadWhereInput[] = [];

    if (input.email) {
      conditions.push({ email: { equals: input.email, mode: Prisma.QueryMode.insensitive } });
    }
    if (input.phone) {
      conditions.push({ phone: input.phone });
    }
    if (input.company && (input.firstName || input.lastName)) {
      const nameOr: Prisma.LeadWhereInput[] = [];
      if (input.firstName) nameOr.push({ firstName: { contains: input.firstName, mode: Prisma.QueryMode.insensitive } });
      if (input.lastName) nameOr.push({ lastName: { contains: input.lastName, mode: Prisma.QueryMode.insensitive } });
      conditions.push({
        AND: [
          { company: { contains: input.company, mode: Prisma.QueryMode.insensitive } },
          { OR: nameOr },
        ],
      });
    }

    if (!conditions.length) return [];

    const where: Prisma.LeadWhereInput = {
      tenantId: ctx.tenantId,
      deletedAt: { equals: null },
      OR: conditions,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
    };

    return this.prisma.lead.findMany({
      where,
      take: 5,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        company: true,
        stage: true,
        status: true,
        ownerId: true,
        createdAt: true,
      },
    });
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
          company: input.contact.company ?? lead.company ?? null,
        },
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
          expectedCloseDate: input.opportunity.expectedCloseDate ?? null,
        },
      });

      await tx.pipeline.create({
        data: {
          tenantId: ctx.tenantId,
          opportunityId: opportunity.id,
          stage: opportunity.stage,
          enteredAt: new Date(),
        },
      });

      await tx.lead.update({
        where: { id: leadId },
        data: { status: LeadStatus.CONVERTED },
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
        opportunityTitle: input.opportunity.title,
      },
    });

    return result;
  }

  /** Soft-delete a lead */
  async deleteLead(ctx: TenantContext, leadId: string) {
    await this.getLeadById(ctx, leadId);

    await this.prisma.lead.update({
      where: { id: leadId },
      data: { deletedAt: new Date() },
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'LEAD_DELETED',
      entityType: 'Lead',
      entityId: leadId,
      actorUserId: ctx.userId,
      operation: 'DELETE',
      payload: {},
    });
  }

  /** Bulk soft-delete */
  async bulkSoftDelete(ctx: TenantContext, leadIds: string[]) {
    const result = await this.prisma.lead.updateMany({
      where: { id: { in: leadIds }, tenantId: ctx.tenantId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'LEADS_BULK_DELETED',
      entityType: 'Lead',
      entityId: leadIds.join(','),
      actorUserId: ctx.userId,
      operation: 'DELETE',
      payload: { count: result.count },
    });

    return { count: result.count };
  }

  /** List soft-deleted leads */
  async listDeleted(ctx: TenantContext, page = 1, pageSize = 50) {
    const where: Prisma.LeadWhereInput = {
      tenantId: ctx.tenantId,
      deletedAt: { not: null },
    };

    const [data, total] = await Promise.all([
      (this.prisma as any).lead.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { deletedAt: 'desc' },
        include: { tags: { include: { tag: true } } },
      }),
      this.prisma.lead.count({ where }),
    ]);

    const enriched = data.map((l: any) => ({
      ...l,
      tags: (l.tags ?? []).map((a: any) => a.tag),
    }));

    return { data: enriched, total, page, pageSize };
  }

  /** Restore a soft-deleted lead */
  async restoreLead(ctx: TenantContext, leadId: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, tenantId: ctx.tenantId, deletedAt: { not: null } } });
    if (!lead) throw new ResourceNotFoundError();

    await this.prisma.lead.update({
      where: { id: leadId },
      data: { deletedAt: null },
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'LEAD_RESTORED',
      entityType: 'Lead',
      entityId: leadId,
      actorUserId: ctx.userId,
      operation: 'UPDATE',
      payload: {},
    });
  }

  /** Bulk restore soft-deleted leads */
  async bulkRestore(ctx: TenantContext, leadIds: string[]) {
    const result = await this.prisma.lead.updateMany({
      where: { id: { in: leadIds }, tenantId: ctx.tenantId, deletedAt: { not: null } },
      data: { deletedAt: null },
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'LEADS_BULK_RESTORED',
      entityType: 'Lead',
      entityId: leadIds.join(','),
      actorUserId: ctx.userId,
      operation: 'UPDATE',
      payload: { count: result.count },
    });

    return { count: result.count };
  }

  /** Permanently delete a lead */
  async permanentDeleteLead(ctx: TenantContext, leadId: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.tenantId !== ctx.tenantId) throw new ResourceNotFoundError();
    if (!lead.deletedAt) throw new ValidationError('Lead must be soft-deleted before permanent deletion.');

    await this.prisma.lead.delete({ where: { id: leadId } });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'LEAD_PERMANENTLY_DELETED',
      entityType: 'Lead',
      entityId: leadId,
      actorUserId: ctx.userId,
      operation: 'DELETE',
      payload: { firstName: lead.firstName, lastName: lead.lastName },
    });
  }

  /** Bulk permanently delete leads */
  async bulkPermanentDelete(ctx: TenantContext, leadIds: string[]) {
    const result = await this.prisma.lead.deleteMany({
      where: { id: { in: leadIds }, tenantId: ctx.tenantId, deletedAt: { not: null } },
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'LEADS_BULK_PERMANENTLY_DELETED',
      entityType: 'Lead',
      entityId: leadIds.join(','),
      actorUserId: ctx.userId,
      operation: 'DELETE',
      payload: { count: result.count },
    });

    return { count: result.count };
  }
}
