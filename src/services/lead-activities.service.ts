import { PrismaClient } from '@prisma/client';
import { TenantContext } from './lead.service';
import { ResourceNotFoundError, ValidationError } from '../types/exceptions';

export type GlobalFilter = 'ALL' | 'DUE_TODAY' | 'UPCOMING' | 'OVERDUE' | 'MINE';

export class LeadActivitiesService {
  constructor(private readonly prisma: PrismaClient) {}

  async listGlobal(ctx: TenantContext, filter: GlobalFilter, page: number, pageSize: number) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 86_400_000);

    const baseWhere: any = { tenantId: ctx.tenantId, deletedAt: null };

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
          lead: { select: { id: true, firstName: true, lastName: true, stage: true } },
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

  async markComplete(ctx: TenantContext, activityId: string) {
    const activity = await (this.prisma as any).leadActivity.findFirst({
      where: { id: activityId, tenantId: ctx.tenantId, deletedAt: null },
    });
    if (!activity) throw new ResourceNotFoundError();
    return (this.prisma as any).leadActivity.update({
      where: { id: activityId },
      data: { state: 'COMPLETED', completedAt: new Date() },
    });
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
