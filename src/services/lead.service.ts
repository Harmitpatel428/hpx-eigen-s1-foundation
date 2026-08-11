import { PrismaClient, Prisma, LeadStatus, LeadSource, LeadStage, LeadPriority, OpportunityCurrency, UserStatus, NotificationType } from '@prisma/client';
import { AuditService } from './audit.service';
import { NotificationService } from './notification.service';
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
  private readonly notifications: NotificationService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
    this.notifications = new NotificationService(prisma);
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
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenantId: ctx.tenantId },
    });
    if (!lead) throw new ResourceNotFoundError();
    return lead;
  }

  /** Get lead with tag assignments */
  private async getLeadWithTags(ctx: TenantContext, leadId: string) {
    const lead = await (this.prisma as any).lead.findFirst({
      where: { id: leadId, tenantId: ctx.tenantId },
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
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, tenantId: ctx.tenantId } });
    if (!lead) throw new ResourceNotFoundError();
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

  // ponytail: active workload = not terminal (DISQUALIFIED/CONVERTED) and not soft-deleted
  private readonly ACTIVE_STATUSES = [LeadStatus.NEW, LeadStatus.CONTACTED, LeadStatus.QUALIFIED];

  private async computeDistribution(
    ctx: TenantContext,
    leadIds: string[],
    departmentId: string,
    db: Prisma.TransactionClient | PrismaClient
  ) {
    const leads = await (db as any).lead.findMany({
      where: { id: { in: leadIds }, tenantId: ctx.tenantId, deletedAt: null },
      select: { id: true },
    });
    if (leads.length === 0) throw new ValidationError('No eligible leads found to assign.');

    const eligibleLeadIds: string[] = leads.map((l: { id: string }) => l.id);

    const employees = await (db as any).user.findMany({
      where: { tenantId: ctx.tenantId, departmentId, deletedAt: null, status: UserStatus.ACTIVE },
      select: { id: true, firstName: true, lastName: true },
      orderBy: { id: 'asc' }, // deterministic tie-break
    });
    if (employees.length === 0) return { assignments: [], employees: [], eligibleLeadIds };

    // ponytail: READ COMMITTED isolation — acceptable race window for concurrent auto-assigns
    const workloadCounts: number[] = await Promise.all(
      employees.map((emp: { id: string }) =>
        (db as any).lead.count({
          where: {
            ownerId: emp.id,
            tenantId: ctx.tenantId,
            deletedAt: null,
            status: { in: this.ACTIVE_STATUSES },
            id: { notIn: eligibleLeadIds },
          },
        })
      )
    );

    const empState: Array<{ id: string; firstName: string | null; lastName: string | null; base: number; delta: number }> =
      employees.map((e: { id: string; firstName: string | null; lastName: string | null }, i: number) => ({
        id: e.id,
        firstName: e.firstName,
        lastName: e.lastName,
        base: workloadCounts[i],
        delta: 0,
      }));

    const assignments: Array<{ leadId: string; assigneeId: string }> = [];

    for (const leadId of eligibleLeadIds) {
      empState.sort((a, b) => {
        const wa = a.base + a.delta;
        const wb = b.base + b.delta;
        return wa !== wb ? wa - wb : a.id.localeCompare(b.id);
      });
      empState[0].delta += 1;
      assignments.push({ leadId, assigneeId: empState[0].id });
    }

    return {
      assignments,
      eligibleLeadIds,
      employees: empState.map(e => ({
        id: e.id,
        firstName: e.firstName,
        lastName: e.lastName,
        currentWorkload: e.base,
        delta: e.delta,
      })),
    };
  }

  async previewAutoAssign(
    ctx: TenantContext,
    leadIds: string[],
    departmentId: string
  ) {
    const { employees, eligibleLeadIds } = await this.computeDistribution(ctx, leadIds, departmentId, this.prisma);
    return { employees, totalLeads: eligibleLeadIds.length };
  }

  async bulkAssign(
    ctx: TenantContext,
    input: { leadIds: string[]; mode: 'MANUAL' | 'AUTO'; userId?: string; departmentId?: string }
  ): Promise<{ count: number }> {
    if (input.mode === 'MANUAL') {
      if (!input.userId) throw new ValidationError('userId is required for MANUAL mode.');

      const target = await this.prisma.user.findFirst({
        where: { id: input.userId, tenantId: ctx.tenantId, deletedAt: null, status: UserStatus.ACTIVE },
      });
      if (!target) throw new ResourceNotFoundError();

      const result = await this.prisma.lead.updateMany({
        where: { id: { in: input.leadIds }, tenantId: ctx.tenantId, deletedAt: null },
        data: { ownerId: input.userId },
      });

      await this.audit.log({
        tenantId: ctx.tenantId,
        eventType: 'LEADS_BULK_ASSIGNED',
        entityType: 'Lead',
        entityId: input.leadIds.join(','),
        actorUserId: ctx.userId,
        operation: 'UPDATE',
        payload: { mode: 'MANUAL', targetUserId: input.userId, count: result.count },
      });

      // Notify the new assignee (fire-and-forget — never block the response)
      if (input.userId !== ctx.userId) {
        this.notifications.create({
          tenantId: ctx.tenantId,
          recipientUserId: input.userId,
          type: NotificationType.LEAD_ASSIGNED,
          title: 'Leads Assigned',
          message: `${result.count} lead${result.count !== 1 ? 's' : ''} have been assigned to you.`,
        }).catch(() => {/* non-fatal */});
      }

      return { count: result.count };
    }

    // AUTO mode
    if (!input.departmentId) throw new ValidationError('departmentId is required for AUTO mode.');

    let count = 0;
    await this.prisma.$transaction(async (tx) => {
      const { assignments } = await this.computeDistribution(ctx, input.leadIds, input.departmentId!, tx);
      if (assignments.length === 0) throw new ValidationError('No eligible employees in the selected department.');

      await Promise.all(
        assignments.map(({ leadId, assigneeId }) =>
          tx.lead.update({ where: { id: leadId }, data: { ownerId: assigneeId } })
        )
      );
      count = assignments.length;
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'LEADS_BULK_ASSIGNED',
      entityType: 'Lead',
      entityId: input.leadIds.join(','),
      actorUserId: ctx.userId,
      operation: 'UPDATE',
      payload: { mode: 'AUTO', departmentId: input.departmentId, count },
    });

    // Notify each newly assigned user — fire-and-forget
    const assignedResult = await this.prisma.lead.findMany({
      where: { id: { in: input.leadIds }, tenantId: ctx.tenantId, deletedAt: null },
      select: { ownerId: true },
    });
    const countsPerAssignee: Record<string, number> = {};
    for (const { ownerId } of assignedResult) {
      if (ownerId && ownerId !== ctx.userId) countsPerAssignee[ownerId] = (countsPerAssignee[ownerId] ?? 0) + 1;
    }
    this.notifications.createMany(
      Object.entries(countsPerAssignee).map(([uid, n]) => ({
        tenantId: ctx.tenantId,
        recipientUserId: uid,
        type: NotificationType.LEAD_ASSIGNED,
        title: 'Leads Assigned',
        message: `${n} lead${n !== 1 ? 's' : ''} have been assigned to you.`,
      }))
    ).catch(() => {/* non-fatal */});

    return { count };
  }
}
