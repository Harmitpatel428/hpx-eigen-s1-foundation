import { PrismaClient, OpportunityStage, OpportunityCurrency, Prisma } from '@prisma/client';
import { BaseRepository, TenantContext } from './base.repo';
import { ResourceNotFoundError, BusinessRuleViolationError } from '../types/exceptions';

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

export class OpportunityRepository extends BaseRepository {
  constructor(ctx: TenantContext, private readonly prisma: PrismaClient) {
    super(ctx);
  }

  /** Create a new opportunity in PROSPECTING stage */
  async create(input: CreateOpportunityInput) {
    return this.prisma.opportunity.create({
      data: {
        tenantId: this.ctx.tenantId,
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
  }

  /** Find opportunity by ID — tenant-scoped, throws if not found */
  async findById(opportunityId: string) {
    const opp = await this.prisma.opportunity.findFirst({
      where: {
        ...this.buildTenantFilter(),
        id: opportunityId
      },
      include: {
        lead: { select: { id: true, firstName: true, lastName: true, company: true } },
        contact: { select: { id: true, firstName: true, lastName: true } },
        opportunityType: { select: { id: true, name: true, isDefault: true } }
      }
    });
    if (!opp) throw new ResourceNotFoundError();
    return opp;
  }

  /** List all non-deleted opportunities in the tenant */
  async findAll(options?: { stage?: OpportunityStage; ownerId?: string }) {
    return this.prisma.opportunity.findMany({
      where: {
        ...this.buildTenantFilter(),
        ...(options?.stage ? { stage: options.stage } : {}),
        ...(options?.ownerId ? { ownerId: options.ownerId } : {})
      },
      include: {
        opportunityType: { select: { id: true, name: true, isDefault: true } },
        lead: { select: { id: true, firstName: true, lastName: true, company: true, email: true, phone: true } },
        contact: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /** Find opportunities by pipeline stage */
  async findByStage(stage: OpportunityStage) {
    return this.prisma.opportunity.findMany({
      where: {
        ...this.buildTenantFilter(),
        stage
      },
      include: {
        opportunityType: { select: { id: true, name: true, isDefault: true } }
      },
      orderBy: { expectedCloseDate: 'asc' }
    });
  }

  /** Find opportunities owned by a specific user */
  async findByOwner(ownerId: string) {
    return this.prisma.opportunity.findMany({
      where: {
        ...this.buildTenantFilter(),
        ownerId
      },
      include: {
        opportunityType: { select: { id: true, name: true, isDefault: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /** Update opportunity fields */
  async update(opportunityId: string, input: UpdateOpportunityInput) {
    await this.findById(opportunityId);

    return this.prisma.opportunity.update({
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
  }

  /**
   * Advance opportunity to the next stage.
   * Records a Pipeline entry for the stage transition.
   *
   * Stage order: PROSPECTING → QUALIFICATION → PROPOSAL → NEGOTIATION → CLOSED_WON/CLOSED_LOST
   */
  async advanceStage(opportunityId: string, newStage: OpportunityStage, lostReason?: string) {
    const opp = await this.findById(opportunityId);

    const terminalStages: OpportunityStage[] = [
      OpportunityStage.CLOSED_WON,
      OpportunityStage.CLOSED_LOST
    ];

    if (terminalStages.includes(opp.stage)) {
      throw new BusinessRuleViolationError(); // Cannot advance a closed deal
    }

    const isClosing = terminalStages.includes(newStage);

    return this.prisma.$transaction(async (tx) => {
      // Close the current pipeline stage record
      await tx.pipeline.updateMany({
        where: { opportunityId, tenantId: this.ctx.tenantId, exitedAt: null },
        data: { exitedAt: new Date() }
      });

      // Open a new pipeline stage record
      await tx.pipeline.create({
        data: {
          tenantId: this.ctx.tenantId,
          opportunityId,
          stage: newStage,
          enteredAt: new Date()
        }
      });

      // Update the opportunity stage
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
  }

  /** Soft-delete an opportunity */
  async softDelete(opportunityId: string) {
    await this.findById(opportunityId);
    return this.prisma.opportunity.update({
      where: { id: opportunityId },
      data: { deletedAt: new Date() }
    });
  }
}
