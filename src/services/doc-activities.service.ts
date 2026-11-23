import { PrismaClient, DocActivityState, DocActivityType, Prisma } from '@prisma/client';
import { ResourceNotFoundError, ValidationError } from '../types/exceptions';
import { docCaseVisibilityWhere } from '../utils/doc-case-visibility.helper';

export type DocActivityFilter = 'ALL' | 'DUE_TODAY' | 'UPCOMING' | 'OVERDUE' | 'MINE';

export interface DocActivityCtx { tenantId: string; userId: string; }

/**
 * Documentation-department activities. Every read is scoped by DocCase visibility
 * (docCaseVisibilityWhere) in addition to tenant, so this surface can only ever
 * return Documentation rows the caller is allowed to see — and `LeadActivity` /
 * opportunity `Activity` queries never touch this table.
 */
export class DocActivitiesService {
  constructor(private readonly prisma: PrismaClient) {}

  async listGlobal(
    ctx: DocActivityCtx,
    restrictToUserId: string | undefined,
    filter: DocActivityFilter = 'ALL',
    page = 1,
    pageSize = 50,
  ) {
    // Follow-up dates are stored as UTC midnight — use UTC day boundaries (same as LeadActivity).
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayEnd = new Date(todayStart.getTime() + 86_400_000);

    const where: Prisma.DocActivityWhereInput = {
      tenantId: ctx.tenantId,
      deletedAt: null,
      case: { deletedAt: null, ...docCaseVisibilityWhere(restrictToUserId) },
    };

    if (filter === 'DUE_TODAY') {
      where.scheduledAt = { gte: todayStart, lt: todayEnd };
      where.state = DocActivityState.PENDING;
    } else if (filter === 'UPCOMING') {
      where.scheduledAt = { gte: todayEnd };
      where.state = DocActivityState.PENDING;
    } else if (filter === 'OVERDUE') {
      where.scheduledAt = { lt: todayStart };
      where.state = DocActivityState.PENDING;
    } else if (filter === 'MINE') {
      where.actorUserId = ctx.userId; // the caller's own, not restrictToUserId
      where.state = DocActivityState.PENDING;
    }

    const skip = (page - 1) * pageSize;
    const [rows, total] = await Promise.all([
      this.prisma.docActivity.findMany({
        where,
        orderBy: { scheduledAt: 'asc' },
        skip,
        take: pageSize,
        include: { case: { select: { id: true, caseNumber: true, leadId: true, lead: { select: { id: true, company: true, firstName: true, lastName: true } } } } },
      }),
      this.prisma.docActivity.count({ where }),
    ]);

    // Resolve actor names for the "by {actor}" row meta (DocActivity has no actor relation;
    // same manual-map pattern leads use for owner). One query, in-tenant.
    const actorIds = [...new Set(rows.map(r => r.actorUserId).filter(Boolean))] as string[];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: actorIds }, tenantId: ctx.tenantId }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const actorMap = new Map(actors.map(a => [a.id, a]));
    const data = rows.map(r => ({ ...r, actor: r.actorUserId ? actorMap.get(r.actorUserId) ?? null : null }));

    return { data, total, page, pageSize };
  }

  async create(
    ctx: DocActivityCtx,
    restrictToUserId: string | undefined,
    caseId: string,
    input: { type: DocActivityType; subject: string; scheduledAt?: string; metadata?: Record<string, unknown> },
  ) {
    if (!input.type || !Object.values(DocActivityType).includes(input.type)) {
      throw new ValidationError('type must be a valid activity type.');
    }
    if (!input.subject?.trim()) throw new ValidationError('subject is required.');
    if (input.scheduledAt && isNaN(Date.parse(input.scheduledAt))) {
      throw new ValidationError('scheduledAt must be a valid date.');
    }

    // Trust boundary: the case must exist in the tenant AND be visible to the caller.
    const docCase = await this.prisma.docCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null, ...docCaseVisibilityWhere(restrictToUserId) },
      select: { id: true },
    });
    if (!docCase) throw new ResourceNotFoundError();

    return this.prisma.docActivity.create({
      data: {
        tenantId: ctx.tenantId,
        caseId,
        actorUserId: ctx.userId,
        type: input.type,
        subject: input.subject.trim(),
        state: input.scheduledAt ? DocActivityState.PENDING : DocActivityState.COMPLETED,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Update an existing activity's follow-up date and/or notes in place. This is the
   * root fix for the "old date still shows" bug: editing a follow-up must mutate the
   * existing PENDING row, not insert a second one that the soonest-wins chip ignores.
   * Notes live on metadata.notes (single source of truth; surfaced in the case Notes
   * section and on the activity row) — no DocCaseNote duplication, so repeated edits
   * never stack note rows.
   */
  async update(
    ctx: DocActivityCtx,
    restrictToUserId: string | undefined,
    id: string,
    input: { scheduledAt?: string; notes?: string },
  ) {
    if (input.scheduledAt !== undefined && input.scheduledAt !== null && isNaN(Date.parse(input.scheduledAt))) {
      throw new ValidationError('scheduledAt must be a valid date.');
    }
    // Trust boundary: same visible-case scope as complete() — can't edit an activity
    // on a case the caller cannot see.
    const activity = await this.prisma.docActivity.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId,
        deletedAt: null,
        case: { deletedAt: null, ...docCaseVisibilityWhere(restrictToUserId) },
      },
      select: { id: true, metadata: true },
    });
    if (!activity) throw new ResourceNotFoundError();

    const data: Prisma.DocActivityUpdateInput = {};
    if (input.scheduledAt !== undefined) {
      data.scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
    }
    if (input.notes !== undefined) {
      const meta = (activity.metadata && typeof activity.metadata === 'object' && !Array.isArray(activity.metadata))
        ? { ...(activity.metadata as Record<string, unknown>) } : {};
      const n = input.notes.trim();
      if (n) meta.notes = n; else delete meta.notes; // empty clears → no empty-note artifact
      data.metadata = meta as Prisma.InputJsonValue;
    }
    return this.prisma.docActivity.update({ where: { id: activity.id }, data });
  }

  async complete(
    ctx: DocActivityCtx,
    restrictToUserId: string | undefined,
    id: string,
    opts?: { nextFollowUp?: string; note?: string },
  ) {
    if (opts?.nextFollowUp && isNaN(Date.parse(opts.nextFollowUp))) {
      throw new ValidationError('nextFollowUp must be a valid date.');
    }
    // Trust boundary: load via the visible-case scope so a caller can't complete
    // an activity on a case they cannot see.
    const activity = await this.prisma.docActivity.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId,
        deletedAt: null,
        case: { deletedAt: null, ...docCaseVisibilityWhere(restrictToUserId) },
      },
      select: { id: true, caseId: true },
    });
    if (!activity) throw new ResourceNotFoundError();

    const note = opts?.note?.trim();
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.docActivity.update({
        where: { id: activity.id },
        data: { state: DocActivityState.COMPLETED, completedAt: new Date() },
      });
      // Completion note → a case note (the Doc equivalent of Sales writing the note to
      // lead notes), so it surfaces in the case Notes section.
      if (note) {
        await tx.docCaseNote.create({
          data: { tenantId: ctx.tenantId, caseId: activity.caseId, noteType: 'INTERNAL', content: note, createdBy: ctx.userId },
        });
      }
      if (opts?.nextFollowUp) {
        await tx.docActivity.create({
          data: {
            tenantId: ctx.tenantId,
            caseId: activity.caseId,
            actorUserId: ctx.userId,
            type: DocActivityType.FOLLOW_UP,
            subject: 'Follow-up',
            state: DocActivityState.PENDING,
            scheduledAt: new Date(opts.nextFollowUp),
            metadata: {},
          },
        });
      }
      return updated;
    });
  }

  /**
   * Bulk-complete — mirrors Sales POST /lead-activities/bulk-complete. Only PENDING
   * activities the caller can actually see are updated; invisible/cross-tenant ids are
   * silently skipped (never 404s on a batch), and the returned count reflects real writes.
   */
  async bulkComplete(
    ctx: DocActivityCtx,
    restrictToUserId: string | undefined,
    ids: string[],
  ): Promise<{ count: number }> {
    if (!Array.isArray(ids) || ids.length === 0) throw new ValidationError('ids must be a non-empty array.');
    const visible = await this.prisma.docActivity.findMany({
      where: {
        id: { in: ids },
        tenantId: ctx.tenantId,
        deletedAt: null,
        state: DocActivityState.PENDING,
        case: { deletedAt: null, ...docCaseVisibilityWhere(restrictToUserId) },
      },
      select: { id: true },
    });
    if (visible.length === 0) return { count: 0 };
    const res = await this.prisma.docActivity.updateMany({
      where: { id: { in: visible.map(v => v.id) } },
      data: { state: DocActivityState.COMPLETED, completedAt: new Date() },
    });
    return { count: res.count };
  }
}
