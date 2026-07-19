import { PrismaClient, LeadStatus, LeadSource } from '@prisma/client';
import { BaseRepository, TenantContext } from './base.repo';
import { ResourceNotFoundError, DuplicateResourceError } from '../types/exceptions';

export interface CreateLeadInput {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  company?: string;
  source?: LeadSource;
  notes?: string;
  ownerId?: string;
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
}

export class LeadRepository extends BaseRepository {
  constructor(ctx: TenantContext, private readonly prisma: PrismaClient) {
    super(ctx);
  }

  /** Create a new lead — tenant-scoped */
  async create(input: CreateLeadInput) {
    return this.prisma.lead.create({
      data: {
        tenantId: this.ctx.tenantId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        company: input.company ?? null,
        source: input.source ?? LeadSource.OTHER,
        status: LeadStatus.NEW,
        notes: input.notes ?? null,
        ownerId: input.ownerId ?? null
      }
    });
  }

  /** Find lead by ID — tenant-scoped, throws if not found */
  async findById(leadId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: {
        ...this.buildTenantFilter(),
        id: leadId
      }
    });
    if (!lead) throw new ResourceNotFoundError();
    return lead;
  }

  /** List all non-deleted leads in the tenant */
  async findAll(options?: { status?: LeadStatus; ownerId?: string }) {
    return this.prisma.lead.findMany({
      where: {
        ...this.buildTenantFilter(),
        ...(options?.status ? { status: options.status } : {}),
        ...(options?.ownerId ? { ownerId: options.ownerId } : {})
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /** Find leads by status */
  async findByStatus(status: LeadStatus) {
    return this.prisma.lead.findMany({
      where: {
        ...this.buildTenantFilter(),
        status
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /** Update lead fields */
  async update(leadId: string, input: UpdateLeadInput) {
    // Confirm exists and is tenant-scoped
    await this.findById(leadId);

    return this.prisma.lead.update({
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
        ...(input.status !== undefined ? { status: input.status } : {})
      }
    });
  }

  /**
   * Convert a lead to CONVERTED status.
   * Called when a Lead becomes a Contact + Opportunity.
   */
  async convert(leadId: string) {
    await this.findById(leadId);
    return this.prisma.lead.update({
      where: { id: leadId },
      data: { status: LeadStatus.CONVERTED }
    });
  }

  /** Soft-delete a lead */
  async softDelete(leadId: string) {
    await this.findById(leadId);
    return this.prisma.lead.update({
      where: { id: leadId },
      data: { deletedAt: new Date() }
    });
  }
}
