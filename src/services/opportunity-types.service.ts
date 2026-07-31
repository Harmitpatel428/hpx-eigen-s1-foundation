import { PrismaClient, OpportunityType, Prisma } from '@prisma/client';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';

export interface UserContext {
  tenantId: string;
  userId: string;
}

export const DEFAULT_OPPORTUNITY_TYPES = [
  "Government Subsidy Consultant",
  "Technology Vendor",
  "Legal Services",
  "Financial Advisor",
  "Marketing Agency",
  "Real Estate Broker",
  "HR Consultant",
  "Insurance Provider",
  "Logistics Partner",
  "Training Provider",
  "Software Subscription",
  "Other"
];

export class OpportunityTypesService {
  constructor(private prisma: PrismaClient) {}

  async ensureDefaultTypes(tx: PrismaClient, ctx: UserContext): Promise<void> {
    const count = await tx.opportunityType.count({
      where: { tenantId: ctx.tenantId, deletedAt: null }
    });

    if (count > 0) return;

    const data = DEFAULT_OPPORTUNITY_TYPES.map((name, index) => ({
      tenantId: ctx.tenantId,
      name,
      displayOrder: index,
      isActive: true,
      isDefault: name === 'Other'
    }));

    await tx.opportunityType.createMany({ data });
  }

  async listTypes(tx: PrismaClient, ctx: UserContext): Promise<OpportunityType[]> {
    await this.ensureDefaultTypes(tx, ctx);
    return tx.opportunityType.findMany({
      where: { tenantId: ctx.tenantId, deletedAt: null },
      orderBy: { displayOrder: 'asc' }
    });
  }

  async createType(tx: PrismaClient, ctx: UserContext, name: string): Promise<OpportunityType> {
    const cleanName = name?.trim() || '';
    if (!cleanName || cleanName.length > 100) {
      throw new ValidationError('Name must be between 1 and 100 characters.');
    }
    
    if (cleanName.toLowerCase() === 'other') {
      throw new ValidationError('"Other" is a reserved opportunity type name.');
    }

    const existing = await tx.opportunityType.findFirst({
      where: { tenantId: ctx.tenantId, name: { equals: cleanName, mode: 'insensitive' }, deletedAt: null }
    });

    if (existing) {
      throw new ValidationError('An opportunity type with this name already exists.');
    }

    const maxOrderType = await tx.opportunityType.findFirst({
      where: { tenantId: ctx.tenantId, deletedAt: null, isDefault: false },
      orderBy: { displayOrder: 'desc' }
    });
    
    let displayOrder = maxOrderType ? maxOrderType.displayOrder + 1 : 0;

    const newType = await tx.opportunityType.create({
      data: {
        tenantId: ctx.tenantId,
        name: cleanName,
        displayOrder,
      }
    });

    // Make sure "Other" is pushed to the bottom
    const otherType = await tx.opportunityType.findFirst({
      where: { tenantId: ctx.tenantId, isDefault: true, name: 'Other', deletedAt: null }
    });
    if (otherType && otherType.displayOrder <= displayOrder) {
      await tx.opportunityType.update({
        where: { id: otherType.id },
        data: { displayOrder: displayOrder + 1 }
      });
    }

    return newType;
  }

  async updateType(tx: PrismaClient, ctx: UserContext, id: string, data: { name?: string; isActive?: boolean }): Promise<OpportunityType> {
    const type = await tx.opportunityType.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null }
    });

    if (!type) {
      throw new ResourceNotFoundError();
    }

    if (type.isDefault && data.name && data.name !== type.name) {
      throw new ValidationError('Cannot rename the default "Other" type.');
    }

    let cleanName = data.name !== undefined ? data.name.trim() : undefined;
    if (cleanName !== undefined) {
       if (!cleanName || cleanName.length > 100) {
          throw new ValidationError('Name must be between 1 and 100 characters.');
       }
       if (cleanName.toLowerCase() === 'other' && !type.isDefault) {
          throw new ValidationError('"Other" is a reserved opportunity type name.');
       }
       const existing = await tx.opportunityType.findFirst({
         where: { tenantId: ctx.tenantId, name: { equals: cleanName, mode: 'insensitive' }, id: { not: id }, deletedAt: null }
       });
       if (existing) {
         throw new ValidationError('An opportunity type with this name already exists.');
       }
    }

    return tx.opportunityType.update({
      where: { id },
      data: {
        ...(cleanName !== undefined && { name: cleanName }),
        ...(data.isActive !== undefined && { isActive: data.isActive })
      }
    });
  }

  async reorderTypes(tx: PrismaClient, ctx: UserContext, typeIds: string[]): Promise<void> {
    const types = await tx.opportunityType.findMany({
      where: { tenantId: ctx.tenantId, deletedAt: null }
    });

    const otherType = types.find(t => t.isDefault && t.name === 'Other');
    
    const updates = [];
    let order = 0;
    for (const id of typeIds) {
      if (otherType && id === otherType.id) continue;
      updates.push(
        tx.opportunityType.update({
          where: { id },
          data: { displayOrder: order++ }
        })
      );
    }
    
    if (otherType) {
      updates.push(
        tx.opportunityType.update({
          where: { id: otherType.id },
          data: { displayOrder: order }
        })
      );
    }

    await tx.$transaction(updates);
  }

  async deleteType(tx: PrismaClient, ctx: UserContext, id: string): Promise<void> {
    const type = await tx.opportunityType.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null }
    });

    if (!type) {
      throw new ResourceNotFoundError();
    }

    if (type.isDefault) {
      throw new ValidationError('Cannot delete the default "Other" type.');
    }

    const inUse = await tx.opportunity.count({
      where: { opportunityTypeId: id, tenantId: ctx.tenantId, deletedAt: null }
    });

    if (inUse > 0) {
      throw new ValidationError('Cannot delete an opportunity type that is currently in use.');
    }

    await tx.opportunityType.update({
      where: { id },
      data: { deletedAt: new Date() }
    });
  }
}
