import { PrismaClient, OpportunityStage } from '@prisma/client';
import { OpportunityRepository, CreateOpportunityInput, UpdateOpportunityInput } from '../repositories/opportunity.repo';
import { PipelineRepository } from '../repositories/pipeline.repo';
import { AuditService } from './audit.service';
import { TenantContext } from '../repositories/base.repo';
import { ValidationError } from '../types/exceptions';

export interface CloseOpportunityInput {
  outcome: 'WON' | 'LOST';
  lostReason?: string;
}

export class OpportunityService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  private makeRepos(ctx: TenantContext) {
    return {
      opportunity: new OpportunityRepository(ctx, this.prisma),
      pipeline: new PipelineRepository(ctx, this.prisma)
    };
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

    const repos = this.makeRepos(ctx);

    // Create opportunity and open its first pipeline stage atomically
    const result = await this.prisma.$transaction(async (tx) => {
      const opportunity = await tx.opportunity.create({
        data: {
          tenantId: ctx.tenantId,
          leadId: input.leadId,
          contactId: input.contactId ?? null,
          ownerId: input.ownerId,
          title: input.title,
          value: input.value,
          currency: input.currency,
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
    const repos = this.makeRepos(ctx);
    return repos.opportunity.findById(opportunityId);
  }

  /** List opportunities with optional filters */
  async listOpportunities(ctx: TenantContext, options?: { stage?: OpportunityStage; ownerId?: string }) {
    const repos = this.makeRepos(ctx);
    return repos.opportunity.findAll(options);
  }

  /** List opportunities by pipeline stage */
  async listByStage(ctx: TenantContext, stage: OpportunityStage) {
    const repos = this.makeRepos(ctx);
    return repos.opportunity.findByStage(stage);
  }

  /** List opportunities owned by a user */
  async listByOwner(ctx: TenantContext, ownerId: string) {
    const repos = this.makeRepos(ctx);
    return repos.opportunity.findByOwner(ownerId);
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
    
    const repos = this.makeRepos(ctx);
    const opportunity = await repos.opportunity.update(opportunityId, input);

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
    const repos = this.makeRepos(ctx);

    // Validate the stage value
    const validStages = Object.values(OpportunityStage);
    if (!validStages.includes(newStage)) {
      throw new ValidationError(`Invalid stage. Must be one of: ${validStages.join(', ')}`);
    }

    const opportunity = await repos.opportunity.advanceStage(opportunityId, newStage, lostReason);

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
    const repos = this.makeRepos(ctx);
    await repos.opportunity.softDelete(opportunityId);

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
