import { PrismaClient } from '@prisma/client';
import { BaseRepository, TenantContext } from './base.repo';
import { ResourceNotFoundError } from '../types/exceptions';

export interface CreateContactInput {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  title?: string;
  company?: string;
  leadId?: string;
}

export interface UpdateContactInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  title?: string;
  company?: string;
  leadId?: string;
}

export class ContactRepository extends BaseRepository {
  constructor(ctx: TenantContext, private readonly prisma: PrismaClient) {
    super(ctx);
  }

  /** Create a new contact — tenant-scoped, optionally linked to a Lead */
  async create(input: CreateContactInput) {
    return this.prisma.contact.create({
      data: {
        tenantId: this.ctx.tenantId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        title: input.title ?? null,
        company: input.company ?? null,
        leadId: input.leadId ?? null
      }
    });
  }

  /** Find contact by ID — tenant-scoped, throws if not found */
  async findById(contactId: string) {
    const contact = await this.prisma.contact.findFirst({
      where: {
        ...this.buildTenantFilter(),
        id: contactId
      }
    });
    if (!contact) throw new ResourceNotFoundError();
    return contact;
  }

  /** List all non-deleted contacts in the tenant */
  async findAll() {
    return this.prisma.contact.findMany({
      where: this.buildTenantFilter(),
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }]
    });
  }

  /** List contacts associated with a specific Lead */
  async findByLead(leadId: string) {
    return this.prisma.contact.findMany({
      where: {
        ...this.buildTenantFilter(),
        leadId
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }]
    });
  }

  /** Update contact fields */
  async update(contactId: string, input: UpdateContactInput) {
    await this.findById(contactId);

    return this.prisma.contact.update({
      where: { id: contactId },
      data: {
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.company !== undefined ? { company: input.company } : {}),
        ...(input.leadId !== undefined ? { leadId: input.leadId } : {})
      }
    });
  }

  /** Soft-delete a contact */
  async softDelete(contactId: string) {
    await this.findById(contactId);
    return this.prisma.contact.update({
      where: { id: contactId },
      data: { deletedAt: new Date() }
    });
  }
}
