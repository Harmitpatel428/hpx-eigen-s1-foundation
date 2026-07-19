import { PrismaClient, ActivityType } from '@prisma/client';
import { ActivityRepository, CreateActivityInput, UpdateActivityInput } from '../repositories/activity.repo';
import { AuditService } from './audit.service';
import { TenantContext } from '../repositories/base.repo';
import { ValidationError } from '../types/exceptions';

export class ActivityService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
  }

  private makeRepo(ctx: TenantContext) {
    return new ActivityRepository(ctx, this.prisma);
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

    const repo = this.makeRepo(ctx);
    const activity = await repo.create({ ...input, userId: ctx.userId });

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
    const repo = this.makeRepo(ctx);
    return repo.findById(activityId);
  }

  /** List activities linked to an opportunity */
  async listByOpportunity(ctx: TenantContext, opportunityId: string) {
    const repo = this.makeRepo(ctx);
    return repo.findByOpportunity(opportunityId);
  }

  /** List activities by type */
  async listByType(ctx: TenantContext, type: ActivityType) {
    const repo = this.makeRepo(ctx);
    return repo.findByType(type);
  }

  /** List activities assigned to a user */
  async listByUser(ctx: TenantContext, userId: string) {
    const repo = this.makeRepo(ctx);
    return repo.findByUser(userId);
  }

  /** Update activity details */
  async updateActivity(ctx: TenantContext, activityId: string, input: UpdateActivityInput) {
    const repo = this.makeRepo(ctx);
    const activity = await repo.update(activityId, input);

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
    const repo = this.makeRepo(ctx);
    const activity = await repo.markComplete(activityId);

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
    const repo = this.makeRepo(ctx);
    await repo.softDelete(activityId);

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
