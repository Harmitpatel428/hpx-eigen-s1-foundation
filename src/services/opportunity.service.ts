import { PrismaClient, Prisma, OpportunityStage, OpportunityCurrency } from '@prisma/client';
import { AuditService } from './audit.service';
import { ValidationError, ResourceNotFoundError, BusinessRuleViolationError } from '../types/exceptions';

export interface TenantContext {
  tenantId: string;
  userId: string;
}

export interface CloseOpportunityInput {
  outcome: 'WON' | 'LOST';
  lostReason?: string;
}

export interface CreateOpportunityInput {
  leadId: string;
  contactId?: string;
  ownerId: string;
  title: string;
  value: number | string;
  currency?: OpportunityCurrency;
  opportunityTypeId?: string;
  customOpportunityType?: string;
  expectedCloseDate?: Date;
}

export interface UpdateOpportunityInput {
  contactId?: string;
  ownerId?: string;
  title?: string;
  value?: number | string;
  currency?: OpportunityCurrency;
  opportunityTypeId?: string;
  customOpportunityType?: string;
  expectedCloseDate?: Date;
}

export class OpportunityService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  /** Create a new opportunity (must be linked to an existing lead) */
  async createOpportunity(ctx: TenantContext, input: CreateOpportunityInput) {
    if (!input.title?.trim()) {
      throw new ValidationError('title is required.');
    }
    if (!input.leadId) {
      throw new ValidationError('leadId is required.');
    }
    if (input.value === undefined || input.value === null || Number(input.value) < 0) {
      throw new ValidationError('value must be a non-negative number.');
    }

    if (input.opportunityTypeId) {
      const type = await this.prisma.opportunityType.findFirst({
        where: { id: input.opportunityTypeId, tenantId: ctx.tenantId, deletedAt: null }
      });
      if (!type) {
        throw new ValidationError('Selected opportunity type is invalid.');
      }
      if (type.isDefault && type.name === 'Other' && !input.customOpportunityType?.trim()) {
        throw new ValidationError('Please specify a custom opportunity type.');
      }
      if ((!type.isDefault || type.name !== 'Other') && input.customOpportunityType) {
        input.customOpportunityType = undefined; // clear it if not 'Other'
      }
    }

    // Create opportunity and open its first pipeline stage atomically
    const result = await this.prisma.$transaction(async (tx) => {
      const opportunity = await tx.opportunity.create({
        data: {
          tenantId: ctx.tenantId,
          leadId: input.leadId,
          contactId: input.contactId ?? null,
          ownerId: input.ownerId,
          title: input.title,
          value: new Prisma.Decimal(input.value),
          currency: input.currency ?? OpportunityCurrency.INR,
          opportunityTypeId: input.opportunityTypeId ?? null,
          customOpportunityType: input.customOpportunityType ?? null,
          stage: OpportunityStage.PROSPECTING,
          expectedCloseDate: input.expectedCloseDate ?? null
        }
      });

      // Open the initial pipeline stage record
      await tx.pipeline.create({
        data: {
          tenantId: ctx.tenantId,
          opportunityId: opportunity.id,
          stage: opportunity.stage,
          enteredAt: new Date()
        }
      });

      return opportunity;
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'OPPORTUNITY_CREATED',
      entityType: 'Opportunity',
      entityId: result.id,
      actorUserId: ctx.userId,
      operation: 'CREATE',
      payload: { title: result.title, value: result.value.toString(), leadId: result.leadId }
    });

    return result;
  }

  /** Get a single opportunity by ID (includes lead + contact summary) */
  async getOpportunityById(ctx: TenantContext, opportunityId: string) {
    const opp = await this.prisma.opportunity.findFirst({
      where: { tenantId: ctx.tenantId, deletedAt: null, id: opportunityId },
      include: {
        lead: { select: { id: true, firstName: true, lastName: true, company: true } },
        contact: { select: { id: true, firstName: true, lastName: true } },
        opportunityType: { select: { id: true, name: true, isDefault: true } }
      }
    });
    if (!opp) throw new ResourceNotFoundError();
    return opp;
  }

  /** List opportunities with optional filters */
  async listOpportunities(ctx: TenantContext, options?: { stage?: OpportunityStage; ownerId?: string }) {
    const opportunities = await this.prisma.opportunity.findMany({
      where: {
        tenantId: ctx.tenantId,
        deletedAt: null,
        ...(options?.stage ? { stage: options.stage } : {}),
        ...(options?.ownerId ? { ownerId: options.ownerId } : {})
      },
      include: {
        lead: true,
        contact: true
      }
    });

    return opportunities.map(opp => ({
      ...opp,
      lead: opp.lead?.deletedAt ? null : opp.lead,
      contact: opp.contact?.deletedAt ? null : opp.contact
    }));
  }

  /** List opportunities by pipeline stage */
  async listByStage(ctx: TenantContext, stage: OpportunityStage) {
    return this.prisma.opportunity.findMany({
      where: { tenantId: ctx.tenantId, deletedAt: null, stage },
      include: {
        opportunityType: { select: { id: true, name: true, isDefault: true } }
      },
      orderBy: { expectedCloseDate: 'asc' }
    });
  }

  /** List opportunities owned by a user */
  async listByOwner(ctx: TenantContext, ownerId: string) {
    return this.prisma.opportunity.findMany({
      where: { tenantId: ctx.tenantId, deletedAt: null, ownerId },
      include: {
        opportunityType: { select: { id: true, name: true, isDefault: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /** Update opportunity metadata (title, value, dates, owner) */
  async updateOpportunity(ctx: TenantContext, opportunityId: string, input: UpdateOpportunityInput) {
    if (input.opportunityTypeId) {
      const type = await this.prisma.opportunityType.findFirst({
        where: { id: input.opportunityTypeId, tenantId: ctx.tenantId, deletedAt: null }
      });
      if (!type) {
        throw new ValidationError('Selected opportunity type is invalid.');
      }
      if (type.isDefault && type.name === 'Other' && !input.customOpportunityType?.trim()) {
        throw new ValidationError('Please specify a custom opportunity type.');
      }
      if ((!type.isDefault || type.name !== 'Other') && input.customOpportunityType) {
        input.customOpportunityType = undefined; // clear it if not 'Other'
      }
    }
    
    const existing = await this.getOpportunityById(ctx, opportunityId);

    const opportunity = await this.prisma.opportunity.update({
      where: { id: opportunityId },
      data: {
        ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.value !== undefined ? { value: new Prisma.Decimal(input.value) } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.opportunityTypeId !== undefined ? { opportunityTypeId: input.opportunityTypeId } : {}),
        ...(input.customOpportunityType !== undefined ? { customOpportunityType: input.customOpportunityType } : {}),
        ...(input.expectedCloseDate !== undefined ? { expectedCloseDate: input.expectedCloseDate } : {})
      }
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'OPPORTUNITY_UPDATED',
      entityType: 'Opportunity',
      entityId: opportunityId,
      actorUserId: ctx.userId,
      operation: 'UPDATE',
      payload: { changes: input }
    });

    return opportunity;
  }

  /**
   * Advance an opportunity to a new pipeline stage.
   * Records a Pipeline transition entry and updates stage atomically.
   */
  async advanceStage(ctx: TenantContext, opportunityId: string, newStage: OpportunityStage, lostReason?: string) {
    const validStages = Object.values(OpportunityStage);
    if (!validStages.includes(newStage)) {
      throw new ValidationError(`Invalid stage. Must be one of: ${validStages.join(', ')}`);
    }

    const opp = await this.getOpportunityById(ctx, opportunityId);

    const terminalStages: OpportunityStage[] = [
      OpportunityStage.CLOSED_WON,
      OpportunityStage.CLOSED_LOST
    ];

    if (terminalStages.includes(opp.stage)) {
      throw new BusinessRuleViolationError(); // Cannot advance a closed deal
    }

    const isClosing = terminalStages.includes(newStage);

    const opportunity = await this.prisma.$transaction(async (tx) => {
      await tx.pipeline.updateMany({
        where: { opportunityId, tenantId: ctx.tenantId, exitedAt: null },
        data: { exitedAt: new Date() }
      });

      await tx.pipeline.create({
        data: {
          tenantId: ctx.tenantId,
          opportunityId,
          stage: newStage,
          enteredAt: new Date()
        }
      });

      return tx.opportunity.update({
        where: { id: opportunityId },
        data: {
          stage: newStage,
          ...(isClosing ? { closedAt: new Date() } : {}),
          ...(newStage === OpportunityStage.CLOSED_LOST && lostReason
            ? { lostReason }
            : {})
        }
      });
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'OPPORTUNITY_STAGE_ADVANCED',
      entityType: 'Opportunity',
      entityId: opportunityId,
      actorUserId: ctx.userId,
      operation: 'UPDATE',
      payload: { newStage, lostReason }
    });

    return opportunity;
  }

  /**
   * Close an opportunity as WON or LOST.
   * Convenience wrapper around advanceStage for the terminal states.
   */
  async closeOpportunity(ctx: TenantContext, opportunityId: string, input: CloseOpportunityInput) {
    const stage = input.outcome === 'WON'
      ? OpportunityStage.CLOSED_WON
      : OpportunityStage.CLOSED_LOST;

    if (input.outcome === 'LOST' && !input.lostReason?.trim()) {
      throw new ValidationError('lostReason is required when closing as LOST.');
    }

    return this.advanceStage(ctx, opportunityId, stage, input.lostReason);
  }

  /** Soft-delete an opportunity */
  async deleteOpportunity(ctx: TenantContext, opportunityId: string) {
    const existing = await this.getOpportunityById(ctx, opportunityId);
    
    await this.prisma.opportunity.update({
      where: { id: opportunityId },
      data: { deletedAt: new Date() }
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'OPPORTUNITY_DELETED',
      entityType: 'Opportunity',
      entityId: opportunityId,
      actorUserId: ctx.userId,
      operation: 'DELETE',
      payload: {}
    });
  }
}
