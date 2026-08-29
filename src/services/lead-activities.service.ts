import { PrismaClient } from '@prisma/client';
import { TenantContext } from './lead.service';
import { ResourceNotFoundError, ValidationError } from '../types/exceptions';
import { buildOwnerFilter, ScopeType, LeadOwnerFilter } from '../utils/scope.helper';

export type GlobalFilter = 'ALL' | 'DUE_TODAY' | 'UPCOMING' | 'OVERDUE' | 'MINE';

export interface ActivityScopeContext {
  scope: ScopeType;
  teamId: string | null;
  departmentId: string | null;
}

export class LeadActivitiesService {
  constructor(private readonly prisma: PrismaClient) {}

  async listGlobal(
    ctx: TenantContext, filter: GlobalFilter, page: number, pageSize: number,
    scopeCtx?: ActivityScopeContext,
  ) {
    // Use UTC boundaries — follow-up dates are stored as UTC midnight
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayEnd = new Date(todayStart.getTime() + 86_400_000);

    // Build lead-ownership filter from the user's ABAC scope
    const ownerFilter: LeadOwnerFilter = scopeCtx
      ? await buildOwnerFilter(scopeCtx.scope, ctx.userId, scopeCtx.teamId, scopeCtx.departmentId, this.prisma, true)
      : {};

    // Exclude activities whose lead has been soft-deleted
    const baseWhere: any = {
      tenantId: ctx.tenantId,
      deletedAt: null,
      lead: { deletedAt: null, ...ownerFilter },
    };

    if (filter === 'DUE_TODAY') {
      baseWhere.scheduledAt = { gte: todayStart, lt: todayEnd };
      baseWhere.state = 'PENDING';
    } else if (filter === 'UPCOMING') {
      baseWhere.scheduledAt = { gte: todayEnd };
      baseWhere.state = 'PENDING';
    } else if (filter === 'OVERDUE') {
      baseWhere.scheduledAt = { lt: todayStart };
      baseWhere.state = 'PENDING';
    } else if (filter === 'MINE') {
      baseWhere.actorUserId = ctx.userId;
      baseWhere.state = 'PENDING';
    }

    const skip = (page - 1) * pageSize;
    const [rows, total] = await Promise.all([
      (this.prisma as any).leadActivity.findMany({
        where: baseWhere,
        orderBy: { scheduledAt: 'asc' },
        skip,
        take: pageSize,
        include: {
          lead: { select: { id: true, firstName: true, lastName: true, stage: true, company: true } },
        },
      }) as Promise<any[]>,
      (this.prisma as any).leadActivity.count({ where: baseWhere }),
    ]);

    const actorIds: string[] = [...new Set(
      rows.filter((a: any) => a.actorUserId).map((a: any) => a.actorUserId as string)
    )];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds }, tenantId: ctx.tenantId },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const actorMap = Object.fromEntries(actors.map((u: any) => [u.id, u]));

    return {
      data: rows.map((a: any) => ({
        ...a,
        actor: a.actorUserId ? (actorMap[a.actorUserId] ?? null) : null,
      })),
      total,
      page,
      pageSize,
    };
  }

  async createActivity(ctx: TenantContext, input: {
    leadId: string;
    type: string;
    subject: string;
    scheduledAt?: string;
    metadata?: Record<string, unknown>;
  }) {
    // Verify lead belongs to tenant
    const lead = await (this.prisma as any).lead.findFirst({
      where: { id: input.leadId, tenantId: ctx.tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!lead) throw new ResourceNotFoundError();

    const activity = await (this.prisma as any).leadActivity.create({
      data: {
        tenantId: ctx.tenantId,
        leadId: input.leadId,
        actorUserId: ctx.userId,
        type: input.type,
        subject: input.subject,
        state: input.scheduledAt ? 'PENDING' : 'COMPLETED',
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        metadata: input.metadata ?? {},
      },
    });
    return activity;
  }

  async markComplete(ctx: TenantContext, activityId: string, opts?: { note?: string; nextFollowUp?: string }) {
    const activity = await (this.prisma as any).leadActivity.findFirst({
      where: { id: activityId, tenantId: ctx.tenantId, deletedAt: null },
    });
    if (!activity) throw new ResourceNotFoundError();

    const metadata = { ...(activity.metadata ?? {}), ...(opts?.note ? { completionNote: opts.note } : {}) };

    const updated = await this.prisma.$transaction(async (tx: any) => {
      const result = await tx.leadActivity.update({
        where: { id: activityId },
        data: { state: 'COMPLETED', completedAt: new Date(), metadata },
      });

      if (opts?.nextFollowUp) {
        await tx.leadActivity.create({
          data: {
            tenantId: ctx.tenantId,
            leadId: activity.leadId,
            actorUserId: ctx.userId,
            type: 'FOLLOW_UP_SCHEDULED',
            subject: 'Follow-up',
            state: 'PENDING',
            scheduledAt: new Date(opts.nextFollowUp),
            metadata: {},
          },
        });
      }

      return result;
    });

    // Persist completion note to lead's main notes (best-effort — completion already succeeded)
    if (opts?.note && opts.note.trim()) {
      try {
        const noteCount = await (this.prisma as any).leadNote.count({
          where: { leadId: activity.leadId, tenantId: ctx.tenantId, deletedAt: null },
        });
        if (noteCount < 15) {
          await (this.prisma as any).leadNote.create({
            data: {
              tenantId: ctx.tenantId,
              leadId: activity.leadId,
              authorId: ctx.userId,
              content: opts.note.trim().slice(0, 500),
            },
          });
        }
      } catch (e) {
        console.error('[MARK_COMPLETE] note save failed:', e);
      }
    }

    return updated;
  }

  async bulkComplete(ctx: TenantContext, ids: string[]) {
    if (!ids.length) throw new ValidationError('ids must not be empty.');
    const result = await (this.prisma as any).leadActivity.updateMany({
      where: { id: { in: ids }, tenantId: ctx.tenantId, deletedAt: null },
      data: { state: 'COMPLETED', completedAt: new Date() },
    });
    return { count: result.count };
  }

  async listByLead(ctx: TenantContext, leadId: string, page: number, pageSize: number) {
    const lead = await (this.prisma as any).lead.findFirst({
      where: { id: leadId, tenantId: ctx.tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!lead) throw new ResourceNotFoundError();

    const where = { leadId, tenantId: ctx.tenantId, deletedAt: null };
    const skip = (page - 1) * pageSize;

    const [data, total] = await Promise.all([
      (this.prisma as any).leadActivity.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }) as Promise<any[]>,
      (this.prisma as any).leadActivity.count({ where }),
    ]);

    const rows: any[] = await data;
    const actorIds: string[] = [...new Set(
      rows.filter((a: any) => a.actorUserId).map((a: any) => a.actorUserId as string)
    )];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds }, tenantId: ctx.tenantId },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const actorMap = Object.fromEntries(actors.map((u: any) => [u.id, u]));

    return {
      data: rows.map((a: any) => ({
        ...a,
        actor: a.actorUserId ? (actorMap[a.actorUserId] ?? null) : null,
      })),
      total,
      page,
      pageSize,
    };
  }
}
