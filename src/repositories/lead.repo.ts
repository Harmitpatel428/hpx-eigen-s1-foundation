import { PrismaClient, LeadStatus, LeadSource, LeadStage, Prisma } from '@prisma/client';
import { BaseRepository, TenantContext } from './base.repo';
import { ResourceNotFoundError } from '../types/exceptions';

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
  data: Awaited<ReturnType<LeadRepository['findById']>>[];
  total: number;
  page: number;
  pageSize: number;
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
        stage: input.stage ?? LeadStage.NEW,
        score: input.score ?? 0,
        expectedValue: input.expectedValue !== undefined
          ? new Prisma.Decimal(input.expectedValue)
          : new Prisma.Decimal(0),
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

  /**
   * List all non-deleted leads in the tenant.
   * Supports server-side search (case-insensitive), pagination, and status/owner filters.
   * Returns paginated metadata: { data, total, page, pageSize }.
   */
  async findAll(options?: FindAllLeadsOptions): Promise<PaginatedLeads> {
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
      ...this.buildTenantFilter(),
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
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
        ...(input.score !== undefined ? { score: input.score } : {}),
        ...(input.expectedValue !== undefined
          ? { expectedValue: new Prisma.Decimal(input.expectedValue) }
          : {})
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
