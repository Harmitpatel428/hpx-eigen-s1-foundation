import { PrismaClient, Prisma, CaseFieldType } from '@prisma/client';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';

type UserContext = { tenantId: string; userId: string };

const CAP = 5000;

/** Stages of the tenant's non-deleted cases (CaseStage has no deletedAt / caseId). */
const liveStages = (tenantId: string): Prisma.CaseStageWhereInput => ({ tenantId, timeline: { case: { deletedAt: null } } });

export class CaseReportsService {
  constructor(private prisma: PrismaClient) {}

  async overdueByStage(ctx: UserContext) {
    const rows = await this.prisma.caseStage.groupBy({
      by: ['key', 'slaState'],
      where: { ...liveStages(ctx.tenantId), slaState: { in: ['OVERDUE', 'AT_RISK'] } },
      _count: { _all: true },
      orderBy: [{ key: 'asc' }, { slaState: 'asc' }],
      take: CAP,
    });
    const byKey = new Map<string, { stageKey: string; overdue: number; atRisk: number }>();
    for (const r of rows) {
      const e = byKey.get(r.key) ?? { stageKey: r.key, overdue: 0, atRisk: 0 };
      if (r.slaState === 'OVERDUE') e.overdue = r._count._all; else e.atRisk = r._count._all;
      byKey.set(r.key, e);
    }
    return [...byKey.values()];
  }

  async onTimeVsLate(ctx: UserContext) {
    const [onTime, late] = await Promise.all([
      this.prisma.caseStage.count({ where: { ...liveStages(ctx.tenantId), slaState: 'COMPLETED_ON_TIME' } }),
      this.prisma.caseStage.count({ where: { ...liveStages(ctx.tenantId), slaState: 'COMPLETED_LATE' } }),
    ]);
    return { onTime, late };
  }

  async casesByOption(ctx: UserContext, fieldId: string) {
    const field = await this.prisma.caseFieldDefinition.findFirst({
      where: { id: fieldId, tenantId: ctx.tenantId, deletedAt: null },
      select: { type: true, reportable: true },
    });
    if (!field) throw new ResourceNotFoundError();
    if (!field.reportable || field.type !== CaseFieldType.SELECT) {
      throw new ValidationError('Field must be a reportable SELECT field.');
    }
    const groups = await this.prisma.caseFieldValue.groupBy({
      by: ['optionId'],
      where: { tenantId: ctx.tenantId, fieldId, deletedAt: null, optionId: { not: null }, case: { deletedAt: null } },
      _count: { _all: true },
      orderBy: { optionId: 'asc' },
      take: CAP,
    });
    const options = await this.prisma.caseFieldOption.findMany({
      where: { tenantId: ctx.tenantId, fieldId },
      select: { id: true, label: true },
    });
    const labels = new Map(options.map((o) => [o.id, o.label]));
    return groups.map((g) => ({ optionId: g.optionId as string, label: labels.get(g.optionId as string) ?? null, count: g._count._all }));
  }
}
