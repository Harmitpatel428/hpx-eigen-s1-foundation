import { PrismaClient, ActivityType, Prisma } from '@prisma/client';
import { BaseRepository, TenantContext } from './base.repo';
import { ResourceNotFoundError } from '../types/exceptions';

export interface CreateActivityInput {
  opportunityId: string;
  userId: string;
  type: ActivityType;
  subject: string;
  notes?: string;
  scheduledAt?: Date;
}

export interface UpdateActivityInput {
  subject?: string;
  notes?: string;
  scheduledAt?: Date;
  completedAt?: Date;
}

export class ActivityRepository extends BaseRepository {
  constructor(ctx: TenantContext, private readonly prisma: PrismaClient) {
    super(ctx);
  }

  /** Log a new activity against an opportunity */
  async create(tx: PrismaClient, input: CreateActivityInput) {
    return tx.activity.create({
      data: {
        tenantId: this.ctx.tenantId,
        opportunityId: input.opportunityId,
        userId: input.userId,
        type: input.type,
        subject: input.subject,
        notes: input.notes ?? null,
        scheduledAt: input.scheduledAt ?? null
      }
    });
  }

  /** Find activity by ID — tenant-scoped, throws if not found */
  async findById(tx: PrismaClient, activityId: string) {
    const activity = await tx.activity.findFirst({
      where: {
        ...this.buildTenantFilter(tx),
        id: activityId
      }
    });
    if (!activity) throw new ResourceNotFoundError();
    return activity;
  }

  /** List all activities for a specific opportunity */
  async findByOpportunity(tx: PrismaClient, opportunityId: string) {
    return tx.activity.findMany({
      where: {
        ...this.buildTenantFilter(tx),
        opportunityId
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /** List all activities of a specific type in the tenant */
  async findByType(tx: PrismaClient, type: ActivityType) {
    return tx.activity.findMany({
      where: {
        ...this.buildTenantFilter(tx),
        type
      },
      orderBy: { scheduledAt: 'asc' }
    });
  }

  /** List all activities assigned to a specific user */
  async findByUser(tx: PrismaClient, userId: string) {
    return tx.activity.findMany({
      where: {
        ...this.buildTenantFilter(tx),
        userId
      },
      orderBy: { scheduledAt: 'asc' }
    });
  }

  /** Update activity details or mark as completed */
  async update(tx: PrismaClient, activityId: string, input: UpdateActivityInput) {
    await this.findById(tx, activityId);

    return tx.activity.update({
      where: { id: activityId },
      data: {
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {})
      }
    });
  }

  /** Mark an activity as completed (sets completedAt to now) */
  async markComplete(tx: PrismaClient, activityId: string) {
    await this.findById(tx, activityId);
    return tx.activity.update({
      where: { id: activityId },
      data: { completedAt: new Date() }
    });
  }

  /** Soft-delete an activity */
  async softDelete(tx: PrismaClient, activityId: string) {
    await this.findById(tx, activityId);
    return tx.activity.update({
      where: { id: activityId },
      data: { deletedAt: new Date() }
    });
  }
}
