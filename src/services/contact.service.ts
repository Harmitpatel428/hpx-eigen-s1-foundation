import { PrismaClient, Prisma } from '@prisma/client';
import { ContactRepository, CreateContactInput, UpdateContactInput } from '../repositories/contact.repo';
import { AuditService } from './audit.service';
import { TenantContext } from '../repositories/base.repo';
import { ValidationError } from '../types/exceptions';

export class ContactService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  private makeRepo(tx: PrismaClient, ctx: TenantContext) {
    return new ContactRepository(ctx, tx);
  }

  /** Create a new contact */
  async createContact(tx: PrismaClient, ctx: TenantContext, input: CreateContactInput) {
    if (!input.firstName?.trim() || !input.lastName?.trim()) {
      throw new ValidationError('firstName and lastName are required.');
    }

    const repo = this.makeRepo(tx, ctx);
    const contact = await repo.create(tx, input);

    await this.audit.log(tx, {
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
  async getContactById(tx: PrismaClient, ctx: TenantContext, contactId: string) {
    const repo = this.makeRepo(tx, ctx);
    return repo.findById(tx, contactId);
  }

  /** List all contacts in the tenant */
  async listContacts(tx: PrismaClient, ctx: TenantContext) {
    const repo = this.makeRepo(tx, ctx);
    return repo.findAll(tx);
  }

  /** List contacts linked to a specific lead */
  async listContactsByLead(tx: PrismaClient, ctx: TenantContext, leadId: string) {
    const repo = this.makeRepo(tx, ctx);
    return repo.findByLead(tx, leadId);
  }

  /** Update a contact */
  async updateContact(tx: PrismaClient, ctx: TenantContext, contactId: string, input: UpdateContactInput) {
    const repo = this.makeRepo(tx, ctx);
    const contact = await repo.update(tx, contactId, input);

    await this.audit.log(tx, {
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
  async deleteContact(tx: PrismaClient, ctx: TenantContext, contactId: string) {
    const repo = this.makeRepo(tx, ctx);
    await repo.softDelete(tx, contactId);

    await this.audit.log(tx, {
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
