import { PrismaClient } from '@prisma/client';
import { TenantContext } from './lead.service';
import { ResourceNotFoundError } from '../types/exceptions';

export class LeadActivitiesService {
  constructor(private readonly prisma: PrismaClient) {}

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
