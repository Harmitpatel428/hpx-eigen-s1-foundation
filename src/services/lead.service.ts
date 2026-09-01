import { PrismaClient, Prisma, LeadStatus, LeadSource, LeadStage, LeadPriority, OpportunityCurrency, UserStatus, NotificationType, LeadActivityType, LeadActivityState } from '@prisma/client';
import { AuditService } from './audit.service';
import { NotificationService } from './notification.service';
import { ValidationError, BusinessRuleViolationError, AppException, RetryTag, ResourceNotFoundError } from '../types/exceptions';
import { AuthorizationDecision } from '../types/authorization';

// Stages that require a followUpDate to be set
export const FOLLOW_UP_REQUIRED_STAGES = new Set<LeadStage>([
  LeadStage.INTERESTED,
  LeadStage.FOLLOW_UP,
  LeadStage.CALL_BACK_REQUESTED,
  LeadStage.CALL_NOT_RECEIVED,
]);

// Stages that are selectable via the UI (legacy CONTACTED/CONVERTED are read-only)
const ACTIVE_STAGES = new Set<LeadStage>([
  LeadStage.NEW,
  LeadStage.QUALIFIED,
  LeadStage.INTERESTED,
  LeadStage.FOLLOW_UP,
  LeadStage.CALL_BACK_REQUESTED,
  LeadStage.CALL_NOT_RECEIVED,
  LeadStage.OTHER,
  LeadStage.DISQUALIFIED,
]);

// FNV-1a 32-bit hash — deterministic, no external dependency
// ponytail: collision probability negligible for CRM tenant/dept counts; upgrade to lock table if collisions matter
function strHash32(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) | 0;
  }
  return h; // signed 32-bit int — valid for pg_advisory_xact_lock(int4, int4)
}

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
  followUpDate?: string | Date | null;
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
  followUpDate?: string | Date | null;
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

  /** Validate that a stage is selectable (not a legacy read-only value) */
  private validateStageSelectable(stage: LeadStage) {
    if (!ACTIVE_STAGES.has(stage)) {
      throw new ValidationError(`stage '${stage}' is not a valid selection.`);
    }
  }

  /** Validate followUpDate requirement for stages that need it */
  private validateFollowUpDate(stage: LeadStage, followUpDate: string | Date | null | undefined) {
    if (FOLLOW_UP_REQUIRED_STAGES.has(stage) && !followUpDate) {
      throw new ValidationError('followUpDate is required for this stage.');
    }
  }

  /** Create a new lead */
  async createLead(ctx: TenantContext, input: CreateLeadInput) {
    if (!input.firstName?.trim() || !input.lastName?.trim()) {
      throw new ValidationError('firstName and lastName are required.');
    }

    const resolvedStage = input.stage ?? LeadStage.NEW;
    if (input.stage) this.validateStageSelectable(input.stage);
    this.validateFollowUpDate(resolvedStage, input.followUpDate ?? null);

    // Invariant: non-date stages must not carry a followUpDate
    const normalizedFollowUpDate = FOLLOW_UP_REQUIRED_STAGES.has(resolvedStage) && input.followUpDate
      ? new Date(input.followUpDate)
      : null;

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
          stage: resolvedStage,
          score: input.score ?? 0,
          expectedValue: input.expectedValue !== undefined
            ? new Prisma.Decimal(input.expectedValue)
            : new Prisma.Decimal(0),
          priority: input.priority ?? LeadPriority.MEDIUM,
          expectedCloseDate: input.expectedCloseDate
            ? new Date(input.expectedCloseDate)
            : null,
          followUpDate: normalizedFollowUpDate,
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

      // Record initial timeline event
      await (tx as any).leadActivity.create({
        data: {
          tenantId: ctx.tenantId,
          leadId: created.id,
          actorUserId: ctx.userId,
          type: LeadActivityType.LEAD_CREATED,
          state: LeadActivityState.COMPLETED,
          subject: 'Lead created',
          metadata: { stage: resolvedStage },
          completedAt: new Date(),
        },
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
          { phone:     { contains: options.search, mode: Prisma.QueryMode.insensitive } },
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

    // Server-side business rule validation (before any DB write)
    if (input.stage !== undefined) {
      this.validateStageSelectable(input.stage);
    }
    // Determine the effective stage after this update (fallback to existing)
    const effectiveStage: LeadStage = input.stage ?? (beforeLead as any).stage ?? LeadStage.NEW;

    // Invariant: non-date stages must not carry a followUpDate.
    // Normalize before validation so stale dates are cleared on any write path.
    if (!FOLLOW_UP_REQUIRED_STAGES.has(effectiveStage)) {
      if (input.followUpDate !== undefined || (beforeLead as any).followUpDate) {
        input.followUpDate = null;
      }
    }

    // followUpDate effective value: a provided value overrides existing.
    // Use `!== undefined` (not the `in` operator) because the router destructures
    // every field from the body and passes them explicitly, so an absent field
    // arrives as `followUpDate: undefined` — an `in` check would treat that as
    // "provided" and wrongly run validation / write null on a priority-only edit.
    const effectiveFollowUpDate = input.followUpDate !== undefined
      ? input.followUpDate
      : (beforeLead as any).followUpDate;
    // Only enforce the follow-up-date requirement when this update actually
    // sets stage or followUpDate. A partial update that changes neither
    // (e.g. priority-only) must not be rejected because the lead already sits
    // in a follow-up stage with a null followUpDate — it isn't modifying that.
    if (input.stage !== undefined || input.followUpDate !== undefined) {
      this.validateFollowUpDate(effectiveStage, effectiveFollowUpDate);
    }

    const ownerChanged = input.ownerId !== undefined && input.ownerId !== (beforeLead as any).ownerId;
    const stageChanged = input.stage !== undefined && input.stage !== (beforeLead as any).stage;
    const followUpDateChanged = input.followUpDate !== undefined &&
      String(input.followUpDate ?? '') !== String((beforeLead as any).followUpDate ?? '');

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
          ...(input.ownerId !== undefined ? {
            ownerId: input.ownerId,
            // Track who last delegated this lead so they retain OWN-scope visibility.
            managerId: input.ownerId ? ctx.userId : null,
          } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.stage !== undefined ? { stage: input.stage } : {}),
          ...(input.score !== undefined ? { score: input.score } : {}),
          ...(input.expectedValue !== undefined
            ? { expectedValue: new Prisma.Decimal(input.expectedValue) }
            : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.expectedCloseDate !== undefined
            ? { expectedCloseDate: input.expectedCloseDate ? new Date(input.expectedCloseDate) : null }
            : {}),
          ...(input.followUpDate !== undefined
            ? { followUpDate: input.followUpDate ? new Date(input.followUpDate) : null }
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

      const now = new Date();

      // Stage change activity
      if (stageChanged) {
        await (tx as any).leadActivity.create({
          data: {
            tenantId: ctx.tenantId,
            leadId,
            actorUserId: ctx.userId,
            type: LeadActivityType.STAGE_CHANGE,
            state: LeadActivityState.COMPLETED,
            subject: 'Stage changed',
            metadata: {
              from: (beforeLead as any).stage,
              to: input.stage,
            },
            completedAt: now,
          },
        });
      }

      // Follow-up scheduling: create/reschedule when stage or followUpDate changes
      const needsFollowUpActivity = FOLLOW_UP_REQUIRED_STAGES.has(effectiveStage) &&
        (stageChanged || followUpDateChanged) && effectiveFollowUpDate;

      if (needsFollowUpActivity) {
        // Cancel stale PENDING follow-up/callback activities for this lead
        await (tx as any).leadActivity.updateMany({
          where: {
            leadId,
            tenantId: ctx.tenantId,
            state: LeadActivityState.PENDING,
            type: { in: [LeadActivityType.FOLLOW_UP_SCHEDULED, LeadActivityType.CALLBACK_SCHEDULED, LeadActivityType.CALL_NOT_RECEIVED_EVENT] },
            deletedAt: null,
          },
          data: { state: LeadActivityState.CANCELLED },
        });

        const actType = effectiveStage === LeadStage.CALL_BACK_REQUESTED
          ? LeadActivityType.CALLBACK_SCHEDULED
          : effectiveStage === LeadStage.CALL_NOT_RECEIVED
          ? LeadActivityType.CALL_NOT_RECEIVED_EVENT
          : LeadActivityType.FOLLOW_UP_SCHEDULED;

        const subject = effectiveStage === LeadStage.CALL_BACK_REQUESTED
          ? 'Callback scheduled'
          : effectiveStage === LeadStage.CALL_NOT_RECEIVED
          ? 'Call not received — follow-up scheduled'
          : 'Follow-up scheduled';

        await (tx as any).leadActivity.create({
          data: {
            tenantId: ctx.tenantId,
            leadId,
            actorUserId: ctx.userId,
            type: actType,
            state: LeadActivityState.PENDING,
            subject,
            metadata: {
              followUpDate: effectiveFollowUpDate instanceof Date
                ? effectiveFollowUpDate.toISOString()
                : new Date(effectiveFollowUpDate).toISOString(),
              stage: effectiveStage,
            },
            scheduledAt: effectiveFollowUpDate instanceof Date
              ? effectiveFollowUpDate
              : new Date(effectiveFollowUpDate),
          },
        });
      }

      // Assignment change activity
      if (ownerChanged) {
        await (tx as any).leadActivity.create({
          data: {
            tenantId: ctx.tenantId,
            leadId,
            actorUserId: ctx.userId,
            type: LeadActivityType.ASSIGNMENT_CHANGE,
            state: LeadActivityState.COMPLETED,
            subject: 'Lead assigned',
            metadata: {
              fromOwnerId: (beforeLead as any).ownerId,
              toOwnerId: input.ownerId,
            },
            completedAt: now,
          },
        });
      }

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

    // entityId uses "bulk:N" instead of the comma-joined UUID list — a list of
    // ~75+ UUIDs exceeds PostgreSQL's 2704-byte btree index row cap on
    // AuditLog_entityType_entityId_idx (error 54000). The delete itself had
    // already committed by then, so the caller got a 500 while every selected
    // lead WAS soft-deleted — the production "bulk delete fails" incident.
    // Same failure/fix as bulkAssign (see its comment); the affected leads are
    // recoverable from Lead.deletedAt + payload count.
    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'LEADS_BULK_DELETED',
      entityType: 'Lead',
      entityId: `bulk:${result.count}`,
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

    // deletedAt must be set explicitly in the where: the global db.ts extension
    // injects `deletedAt: null` otherwise, which never matches a soft-deleted row (P2025).
    await this.prisma.lead.update({
      where: { id: leadId, deletedAt: { not: null } },
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
      // entityId `bulk:N` — see bulkSoftDelete (btree 2704-byte index cap).
      entityId: `bulk:${result.count}`,
      actorUserId: ctx.userId,
      operation: 'UPDATE',
      payload: { count: result.count },
    });

    return { count: result.count };
  }

  /** Permanently delete a lead */
  async permanentDeleteLead(ctx: TenantContext, leadId: string) {
    // Explicit deletedAt:{not:null} — without it the db.ts extension injects
    // deletedAt:null and the soft-deleted row is never found (P2025).
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, tenantId: ctx.tenantId, deletedAt: { not: null } } });
    if (!lead) throw new ResourceNotFoundError();
    if (!lead.deletedAt) throw new ValidationError('Lead must be soft-deleted before permanent deletion.');

    await this.prisma.lead.delete({ where: { id: leadId, deletedAt: { not: null } } });

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
      // entityId `bulk:N` — see bulkSoftDelete (btree 2704-byte index cap).
      entityId: `bulk:${result.count}`,
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
      select: { id: true, firstName: true, lastName: true, email: true },
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

    const empState: Array<{ id: string; firstName: string | null; lastName: string | null; email: string; base: number; delta: number }> =
      employees.map((e: { id: string; firstName: string | null; lastName: string | null; email: string }, i: number) => ({
        id: e.id,
        firstName: e.firstName,
        lastName: e.lastName,
        email: e.email,
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
        email: e.email,
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
    // Deduplicate lead IDs at service boundary — router guarantees non-empty and ≤200
    const uniqueLeadIds = [...new Set(input.leadIds)];

    if (input.mode === 'MANUAL') {
      if (!input.userId) throw new ValidationError('userId is required for MANUAL mode.');

      let count = 0;

      // Pre-read the audit hash chain pointer BEFORE the transaction.
      // Root cause of AUDIT_WRITE_FAILURE at N≥100: AuditService.log() was doing findFirst
      // inside the $transaction callback, adding an extra query on the already-loaded tx
      // connection (which held user.findFirst + lead.findMany(N) + lead.updateMany(N)).
      // On Render free-tier, that 5th query on a resource-pressured connection caused a
      // transient error that was swallowed into AuditWriteFailureError.
      // Moving the read outside the tx uses a short-lived pool connection instead.
      // ponytail: TOCTOU — if another audit event lands between here and tx commit the chain
      // forks (two records share the same previousHash). verifyChain() detects it. Acceptable:
      // concurrent bulk-assigns to the same tenant are rare in this CRM.
      const prevAuditRecord = await this.prisma.auditLog.findFirst({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
        select: { currentHash: true },
      });
      const previousAuditHash = prevAuditRecord?.currentHash ?? null;

      // ponytail: MANUAL intentionally does NOT acquire the advisory lock held by AUTO.
      // Concurrent MANUAL+AUTO on the same leads uses PostgreSQL row-level last-write-wins (READ COMMITTED).
      // This is correct: MANUAL is an explicit user override and should be able to win the race.
      // Adding a lock here would risk deadlock and violates the intent of manual override.
      // Evaluated alternatives: SELECT FOR UPDATE (adds lock contention), optimistic versioning
      // (requires schema change), advisory lock (wrong scope — MANUAL has no department). No change warranted.
      await this.prisma.$transaction(async (tx) => {
        // Validate target employee within the transaction (eliminates TOCTOU on user status)
        const target = await (tx as any).user.findFirst({
          where: { id: input.userId, tenantId: ctx.tenantId, deletedAt: null, status: UserStatus.ACTIVE },
        });
        if (!target) throw new ResourceNotFoundError();

        // Validate that at least some requested leads exist and belong to this tenant
        const validLeads = await (tx as any).lead.findMany({
          where: { id: { in: uniqueLeadIds }, tenantId: ctx.tenantId, deletedAt: null },
          select: { id: true },
        });
        if (validLeads.length === 0) throw new ValidationError('No eligible leads found to assign.');

        const validIds: string[] = validLeads.map((l: { id: string }) => l.id);

        const result = await (tx as any).lead.updateMany({
          where: { id: { in: validIds }, tenantId: ctx.tenantId, deletedAt: null },
          data: { ownerId: input.userId, managerId: ctx.userId },
        });
        count = result.count;

        // Audit inside the transaction — rolls back with the assignment if this throws.
        // entityId uses "bulk:N" instead of the comma-joined UUID list — the list can be
        // 3700+ bytes for N=100, exceeding PostgreSQL's btree maximum (2704 bytes) on the
        // AuditLog_entityType_entityId_idx index (error 54000). This was the production failure.
        // Full leadIds list is not needed here — the Lead table is the source of truth.
        const txAudit = new AuditService(tx as any);
        await txAudit.log({
          tenantId: ctx.tenantId,
          eventType: 'LEADS_BULK_ASSIGNED',
          entityType: 'Lead',
          entityId: `bulk:${count}`,
          actorUserId: ctx.userId,
          operation: 'UPDATE',
          payload: { mode: 'MANUAL', targetUserId: input.userId, count },
        }, previousAuditHash);
      }, { timeout: 30000 });

      // Notifications are fire-and-forget and must NOT be inside the transaction
      if (input.userId !== ctx.userId) {
        this.notifications.create({
          tenantId: ctx.tenantId,
          recipientUserId: input.userId!,
          type: NotificationType.LEAD_ASSIGNED,
          title: 'Leads Assigned',
          message: `${count} lead${count !== 1 ? 's' : ''} have been assigned to you.`,
        }).catch(() => {/* non-fatal */});
      }

      return { count };
    }

    // AUTO mode
    if (!input.departmentId) throw new ValidationError('departmentId is required for AUTO mode.');

    let count = 0;
    // Capture assignments inside the tx so we can send notifications after commit
    // without an extra DB round-trip
    let capturedAssignments: Array<{ leadId: string; assigneeId: string }> = [];

    // Pre-read audit hash before the transaction — same fix as MANUAL path.
    const prevAuditRecordAuto = await this.prisma.auditLog.findFirst({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: 'desc' },
      select: { currentHash: true },
    });
    const previousAuditHashAuto = prevAuditRecordAuto?.currentHash ?? null;

    await this.prisma.$transaction(async (tx) => {
      // Advisory lock per tenant+department — serializes concurrent auto-assigns for the
      // same scope without blocking unrelated tenants or departments.
      // ponytail: FNV-1a 32-bit hash; collision would only cause unnecessary serialization, never data corruption
      const k1 = strHash32(ctx.tenantId);
      const k2 = strHash32(input.departmentId!);
      await (tx as any).$executeRaw`SELECT pg_advisory_xact_lock(${k1}::integer, ${k2}::integer)`;

      // Server always recomputes fresh from current DB state — never trusts preview data
      const { assignments } = await this.computeDistribution(ctx, uniqueLeadIds, input.departmentId!, tx);
      if (assignments.length === 0) throw new ValidationError('No eligible employees in the selected department.');

      // Group assignments by employee → O(employees) updateMany instead of O(leads) individual updates
      const grouped = new Map<string, string[]>();
      for (const { leadId, assigneeId } of assignments) {
        if (!grouped.has(assigneeId)) grouped.set(assigneeId, []);
        grouped.get(assigneeId)!.push(leadId);
      }
      await Promise.all(
        Array.from(grouped.entries()).map(([assigneeId, ids]) =>
          (tx as any).lead.updateMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId },
            data: { ownerId: assigneeId, managerId: ctx.userId },
          })
        )
      );

      count = assignments.length;
      capturedAssignments = assignments;

      // Audit inside the transaction — rolls back with the assignment if this throws.
      // entityId uses "bulk:N" — same reason as MANUAL path (btree index size limit).
      const txAudit = new AuditService(tx as any);
      await txAudit.log({
        tenantId: ctx.tenantId,
        eventType: 'LEADS_BULK_ASSIGNED',
        entityType: 'Lead',
        entityId: `bulk:${count}`,
        actorUserId: ctx.userId,
        operation: 'UPDATE',
        payload: { mode: 'AUTO', departmentId: input.departmentId, count },
      }, previousAuditHashAuto);
    }, { timeout: 30000 });

    // Notifications after commit — built from captured assignments, no extra DB query
    const countsPerAssignee: Record<string, number> = {};
    for (const { assigneeId } of capturedAssignments) {
      if (assigneeId !== ctx.userId) countsPerAssignee[assigneeId] = (countsPerAssignee[assigneeId] ?? 0) + 1;
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
