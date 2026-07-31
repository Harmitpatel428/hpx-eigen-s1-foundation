// @ts-nocheck
import { PrismaClient, Prisma } from '@prisma/client';
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
  async create(tx: PrismaClient, input: CreateContactInput) {
    return tx.contact.create({
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
  async findById(tx: PrismaClient, contactId: string) {
    const contact = await tx.contact.findFirst({
      where: {
        ...this.buildTenantFilter(tx),
        id: contactId
      }
    });
    if (!contact) throw new ResourceNotFoundError();
    return contact;
  }

  /** List all non-deleted contacts in the tenant */
  async findAll(tx: PrismaClient) {
    return tx.contact.findMany({
      where: this.buildTenantFilter(tx),
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }]
    });
  }

  /** List contacts associated with a specific Lead */
  async findByLead(tx: PrismaClient, leadId: string) {
    return tx.contact.findMany({
      where: {
        ...this.buildTenantFilter(tx),
        leadId
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }]
    });
  }

  /** Update contact fields */
  async update(tx: PrismaClient, contactId: string, input: UpdateContactInput) {
    await this.findById(tx, contactId);

    return tx.contact.update({
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
  async softDelete(tx: PrismaClient, contactId: string) {
    await this.findById(tx, contactId);
    return tx.contact.update({
      where: { id: contactId },
      data: { deletedAt: new Date() }
    });
  }
}
