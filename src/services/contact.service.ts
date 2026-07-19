import { PrismaClient } from '@prisma/client';
import { ContactRepository, CreateContactInput, UpdateContactInput } from '../repositories/contact.repo';
import { AuditService } from './audit.service';
import { TenantContext } from '../repositories/base.repo';
import { ValidationError } from '../types/exceptions';

export class ContactService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  private makeRepo(ctx: TenantContext) {
    return new ContactRepository(ctx, this.prisma);
  }

  /** Create a new contact */
  async createContact(ctx: TenantContext, input: CreateContactInput) {
    if (!input.firstName?.trim() || !input.lastName?.trim()) {
      throw new ValidationError('firstName and lastName are required.');
    }

    const repo = this.makeRepo(ctx);
    const contact = await repo.create(input);

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
    const repo = this.makeRepo(ctx);
    return repo.findById(contactId);
  }

  /** List all contacts in the tenant */
  async listContacts(ctx: TenantContext) {
    const repo = this.makeRepo(ctx);
    return repo.findAll();
  }

  /** List contacts linked to a specific lead */
  async listContactsByLead(ctx: TenantContext, leadId: string) {
    const repo = this.makeRepo(ctx);
    return repo.findByLead(leadId);
  }

  /** Update a contact */
  async updateContact(ctx: TenantContext, contactId: string, input: UpdateContactInput) {
    const repo = this.makeRepo(ctx);
    const contact = await repo.update(contactId, input);

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
    const repo = this.makeRepo(ctx);
    await repo.softDelete(contactId);

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
