import { PrismaClient, ActivityType } from '@prisma/client';
import { AuditService } from './audit.service';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';

// Re-defining context type locally since base.repo.ts is deleted
export interface TenantContext {
  tenantId: string;
  userId: string;
}

export interface CreateActivityInput {
  opportunityId: string;
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

export class ActivityService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  /** Log a new activity against an opportunity */
  async createActivity(ctx: TenantContext, input: CreateActivityInput) {
    if (!input.subject?.trim()) {
      throw new ValidationError('subject is required.');
    }
    if (!input.opportunityId) {
      throw new ValidationError('opportunityId is required.');
    }

    const validTypes = Object.values(ActivityType);
    if (!validTypes.includes(input.type)) {
      throw new ValidationError(`type must be one of: ${validTypes.join(', ')}`);
    }

    const activity = await this.prisma.activity.create({
      data: {
        tenantId: ctx.tenantId,
        opportunityId: input.opportunityId,
        userId: ctx.userId,
        type: input.type,
        subject: input.subject,
        notes: input.notes ?? null,
        scheduledAt: input.scheduledAt ?? null
      }
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'ACTIVITY_CREATED',
      entityType: 'Activity',
      entityId: activity.id,
      actorUserId: ctx.userId,
      operation: 'CREATE',
      payload: { type: input.type, subject: input.subject, opportunityId: input.opportunityId }
    });

    return activity;
  }

  /** Get a single activity by ID */
  async getActivityById(ctx: TenantContext, activityId: string) {
    const activity = await this.prisma.activity.findFirst({
      where: { tenantId: ctx.tenantId, deletedAt: null, id: activityId }
    });
    if (!activity) throw new ResourceNotFoundError();
    return activity;
  }

  /** List activities linked to an opportunity */
  async listByOpportunity(ctx: TenantContext, opportunityId: string) {
    return this.prisma.activity.findMany({
      where: { tenantId: ctx.tenantId, deletedAt: null, opportunityId },
      orderBy: { createdAt: 'desc' }
    });
  }

  /** List activities by type */
  async listByType(ctx: TenantContext, type: ActivityType) {
    return this.prisma.activity.findMany({
      where: { tenantId: ctx.tenantId, deletedAt: null, type },
      orderBy: { scheduledAt: 'asc' }
    });
  }

  /** List activities assigned to a user */
  async listByUser(ctx: TenantContext, userId: string) {
    return this.prisma.activity.findMany({
      where: { tenantId: ctx.tenantId, deletedAt: null, userId },
      orderBy: { scheduledAt: 'asc' }
    });
  }

  /** Update activity details */
  async updateActivity(ctx: TenantContext, activityId: string, input: UpdateActivityInput) {
    const existing = await this.getActivityById(ctx, activityId);

    const activity = await this.prisma.activity.update({
      where: { id: activityId },
      data: {
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {})
      }
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'ACTIVITY_UPDATED',
      entityType: 'Activity',
      entityId: activityId,
      actorUserId: ctx.userId,
      operation: 'UPDATE',
      payload: { changes: input }
    });

    return activity;
  }

  /** Mark an activity as complete (sets completedAt = now) */
  async markActivityComplete(ctx: TenantContext, activityId: string) {
    const existing = await this.getActivityById(ctx, activityId);
    
    const activity = await this.prisma.activity.update({
      where: { id: activityId },
      data: { completedAt: new Date() }
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'ACTIVITY_COMPLETED',
      entityType: 'Activity',
      entityId: activityId,
      actorUserId: ctx.userId,
      operation: 'UPDATE',
      payload: { completedAt: activity.completedAt?.toISOString() }
    });

    return activity;
  }

  /** Soft-delete an activity */
  async deleteActivity(ctx: TenantContext, activityId: string) {
    const existing = await this.getActivityById(ctx, activityId);
    
    await this.prisma.activity.update({
      where: { id: activityId },
      data: { deletedAt: new Date() }
    });

    await this.audit.log({
      tenantId: ctx.tenantId,
      eventType: 'ACTIVITY_DELETED',
      entityType: 'Activity',
      entityId: activityId,
      actorUserId: ctx.userId,
      operation: 'DELETE',
      payload: {}
    });
  }
}
