import { PrismaClient } from '@prisma/client';
import { AuditService } from './audit.service';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';

export interface TenantContext {
  tenantId: string;
  userId: string;
}

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

export class ContactService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  /** Create a new contact */
  async createContact(ctx: TenantContext, input: CreateContactInput) {
    if (!input.firstName?.trim() || !input.lastName?.trim()) {
      throw new ValidationError('firstName and lastName are required.');
    }

    const contact = await this.prisma.contact.create({
      data: {
        tenantId: ctx.tenantId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        title: input.title ?? null,
        company: input.company ?? null,
        leadId: input.leadId ?? null
      }
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'CONTACT_CREATED',
      entityType: 'Contact',
      entityId: contact.id,
      actorUserId: ctx.userId,
      operation: 'CREATE',
      payload: { firstName: input.firstName, lastName: input.lastName, email: input.email }
    });

    return contact;
  }

  /** Get a single contact by ID */
  async getContactById(ctx: TenantContext, contactId: string) {
    const contact = await this.prisma.contact.findFirst({
      where: { tenantId: ctx.tenantId, deletedAt: { equals: null }, id: contactId }
    });
    if (!contact) throw new ResourceNotFoundError();
    return contact;
  }

  /** List all contacts in the tenant */
  async listContacts(ctx: TenantContext) {
    return this.prisma.contact.findMany({
      where: { tenantId: ctx.tenantId, deletedAt: { equals: null } },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }]
    });
  }

  /** List contacts linked to a specific lead */
  async listContactsByLead(ctx: TenantContext, leadId: string) {
    return this.prisma.contact.findMany({
      where: { tenantId: ctx.tenantId, deletedAt: { equals: null }, leadId },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }]
    });
  }

  /** Update a contact */
  async updateContact(ctx: TenantContext, contactId: string, input: UpdateContactInput) {
    const existing = await this.getContactById(ctx, contactId);

    const contact = await this.prisma.contact.update({
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

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'CONTACT_UPDATED',
      entityType: 'Contact',
      entityId: contactId,
      actorUserId: ctx.userId,
      operation: 'UPDATE',
      payload: { changes: input }
    });

    return contact;
  }

  /** Soft-delete a contact */
  async deleteContact(ctx: TenantContext, contactId: string) {
    const existing = await this.getContactById(ctx, contactId);

    await this.prisma.contact.update({
      where: { id: contactId },
      data: { deletedAt: new Date() }
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'CONTACT_DELETED',
      entityType: 'Contact',
      entityId: contactId,
      actorUserId: ctx.userId,
      operation: 'DELETE',
      payload: {}
    });
  }
}
