import { PrismaClient, LeadStatus, LeadSource, OpportunityCurrency } from '@prisma/client';
import { LeadRepository, CreateLeadInput, UpdateLeadInput, FindAllLeadsOptions } from '../repositories/lead.repo';
import { ContactRepository } from '../repositories/contact.repo';
import { OpportunityRepository } from '../repositories/opportunity.repo';
import { PipelineRepository } from '../repositories/pipeline.repo';
import { AuditService } from './audit.service';
import { OutboxService } from './outbox.service';
import { TenantContext } from '../repositories/base.repo';
import { ValidationError, BusinessRuleViolationError, AppException, RetryTag } from '../types/exceptions';
import { AuthorizationDecision } from '../types/authorization';

export interface ConvertLeadInput {
  /** Contact details created during conversion */
  contact: {
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    title?: string;
    company?: string;
  };
  /** Opportunity created during conversion */
  opportunity: {
    title: string;
    value: number | string;
    currency?: OpportunityCurrency;
    expectedCloseDate?: Date;
  };
}

export class LeadService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  private makeContext(ctx: TenantContext) {
    return {
      lead: new LeadRepository(ctx, this.prisma),
      contact: new ContactRepository(ctx, this.prisma),
      opportunity: new OpportunityRepository(ctx, this.prisma),
      pipeline: new PipelineRepository(ctx, this.prisma)
    };
  }

  /** Create a new lead */
  async createLead(ctx: TenantContext, input: CreateLeadInput) {
    if (!input.firstName?.trim() || !input.lastName?.trim()) {
      throw new ValidationError('firstName and lastName are required.');
    }

    const repos = this.makeContext(ctx);
    const lead = await this.prisma.$transaction(async (tx) => {
      const txRepos = { lead: new LeadRepository(ctx, tx as any) };
      const created = await txRepos.lead.create(input);

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
    const repos = this.makeContext(ctx);
    return repos.lead.findById(leadId);
  }

  /** List leads with optional filters, search, and pagination */
  async listLeads(ctx: TenantContext, decision: AuthorizationDecision | undefined, options?: FindAllLeadsOptions) {
    if (decision && !decision.allowed) throw new AppException('AUTHORIZATION_ERROR', 'Permission denied.', RetryTag.NON_RETRYABLE, 403);
    const repos = this.makeContext(ctx);
    return repos.lead.findAll(options);
  }

  /** List leads by status */
  async listLeadsByStatus(ctx: TenantContext, status: LeadStatus) {
    const repos = this.makeContext(ctx);
    return repos.lead.findByStatus(status);
  }

  async updateLead(ctx: TenantContext, decision: AuthorizationDecision | undefined, leadId: string, input: UpdateLeadInput) {
    if (decision && !decision.allowed) throw new AppException('AUTHORIZATION_ERROR', 'Permission denied.', RetryTag.NON_RETRYABLE, 403);
    
    const repos = this.makeContext(ctx);
    const beforeLead = await repos.lead.findById(leadId);

    const lead = await this.prisma.$transaction(async (tx) => {
      const txRepos = {
        lead: new LeadRepository(ctx, tx as any)
      };
      
      const updated = await txRepos.lead.update(leadId, input);
      
      const outboxService = new OutboxService(tx as any);
      await outboxService.publish('LeadUpdated', {
        leadId,
        before: beforeLead as Record<string, unknown>,
        after: updated as Record<string, unknown>,
        actorId: ctx.userId
      }, ctx.tenantId);

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
    const repos = this.makeContext(ctx);

    // Ensure lead exists and is not already converted
    const lead = await repos.lead.findById(leadId);
    if (lead.status === LeadStatus.CONVERTED) {
      throw new BusinessRuleViolationError();
    }

    // Execute conversion atomically
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Create contact linked to the lead
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

      // 2. Create opportunity in PROSPECTING stage
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

      // 3. Open the initial pipeline stage record
      await tx.pipeline.create({
        data: {
          tenantId: ctx.tenantId,
          opportunityId: opportunity.id,
          stage: opportunity.stage,
          enteredAt: new Date()
        }
      });

      // 4. Mark lead as CONVERTED
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
    const repos = this.makeContext(ctx);
    await repos.lead.softDelete(leadId);

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
